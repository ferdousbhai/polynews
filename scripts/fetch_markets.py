import json
import httpx
import asyncio
from datetime import datetime, timedelta, UTC
from typing import Union, Any
import os
from pathlib import Path
from google import genai
from pydantic import BaseModel, Field

# Load environment variables (only for local development)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed (e.g., in GitHub Actions)

API_URL = "https://gamma-api.polymarket.com/markets"
OUTPUT_FILE = "data/markets.json"
HISTORY_DIR = "data/history"
TIME_WINDOW = timedelta(days=90)

def ensure_directories() -> None:
    """Create necessary directories"""
    Path("data").mkdir(exist_ok=True)
    Path(HISTORY_DIR).mkdir(exist_ok=True)

async def fetch_page(client: httpx.AsyncClient, offset: int, limit: int) -> list[dict[str, Any]]:
    """Fetch a single page of markets"""
    params = {
        'limit': limit,
        'offset': offset,
        'active': 'true',
        'closed': 'false',
        'archived': 'false'
    }

    try:
        response = await client.get(API_URL, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as e:
        print(f"❌ Error fetching page at offset {offset}: {e}")
        return []

async def fetch_all_markets_async() -> list[dict[str, Any]]:
    """Fetch all active markets from Polymarket API using async parallel requests"""
    print("🔍 Fetching markets from Polymarket API...")

    limit = 100
    safety_limit = 500  # Max offset

    async with httpx.AsyncClient() as client:
        # First, fetch the first page to see how many markets we need
        first_page = await fetch_page(client, 0, limit)

        if not first_page:
            return []

        all_markets = first_page
        print(f"  📊 Fetched first page: {len(first_page)} markets")

        # If we got a full page, there might be more
        if len(first_page) == limit:
            # Create tasks for remaining pages (up to safety limit)
            tasks = []
            for offset in range(limit, safety_limit + 1, limit):
                tasks.append(fetch_page(client, offset, limit))

            # Fetch all pages in parallel
            results = await asyncio.gather(*tasks)

            # Collect all results
            for i, page_markets in enumerate(results):
                if page_markets:
                    all_markets.extend(page_markets)
                    print(f"  📊 Fetched page {i+2}: {len(page_markets)} markets (total: {len(all_markets)})")
                    # Stop if we got less than a full page
                    if len(page_markets) < limit:
                        break
                else:
                    break

    return all_markets

def fetch_all_markets() -> list[dict[str, Any]]:
    """Synchronous wrapper for async fetch"""
    return asyncio.run(fetch_all_markets_async())

def load_historical_snapshots() -> dict[str, str | dict[str, Any] | None]:
    """Load recent historical snapshots for price change calculation"""
    snapshots: dict[str, str | dict[str, Any] | None] = {
        'hour1': None,
        'hours24': None,
        'days7': None
    }

    now = datetime.now(UTC)

    # Get all history files
    history_files = []
    if os.path.exists(HISTORY_DIR):
        history_files = sorted([f for f in os.listdir(HISTORY_DIR) if f.endswith('.json')])

    if not history_files:
        return snapshots

    # Find closest snapshots for each time period
    for filename in reversed(history_files):
        try:
            # Parse timestamp from filename: YYYY-MM-DD_HH-MM.json
            timestamp_str = filename.replace('.json', '')
            file_time = datetime.strptime(timestamp_str, '%Y-%m-%d_%H-%M').replace(tzinfo=UTC)
            time_diff = now - file_time

            # 1 hour snapshot (55-65 minutes ago)
            if snapshots['hour1'] is None and timedelta(minutes=55) <= time_diff <= timedelta(minutes=65):
                snapshots['hour1'] = filename

            # 24 hour snapshot (23-25 hours ago)
            if snapshots['hours24'] is None and timedelta(hours=23) <= time_diff <= timedelta(hours=25):
                snapshots['hours24'] = filename

            # 7 day snapshot (6.5-7.5 days ago)
            if snapshots['days7'] is None and timedelta(days=6.5) <= time_diff <= timedelta(days=7.5):
                snapshots['days7'] = filename

            # Stop if we have all snapshots
            if all(snapshots.values()):
                break
        except ValueError:
            continue

    # Load the snapshot data and index by market ID for O(1) lookups
    for period, filename in snapshots.items():
        if filename and isinstance(filename, str):
            try:
                with open(os.path.join(HISTORY_DIR, filename), 'r') as f:
                    snapshot_data = json.load(f)

                    # Index markets by ID for fast lookups
                    if snapshot_data.get('markets'):
                        indexed_markets = {
                            m.get('id'): m
                            for m in snapshot_data['markets']
                            if m.get('id')
                        }
                        snapshots[period] = {
                            'timestamp': snapshot_data.get('timestamp'),
                            'markets': indexed_markets  # Now a dict instead of list
                        }
                        print(f"  📈 Loaded {period} snapshot: {filename} ({len(indexed_markets)} markets)")
                    else:
                        snapshots[period] = None
            except Exception as e:
                print(f"  ⚠️  Could not load {filename}: {e}")
                snapshots[period] = None

    return snapshots

def get_most_likely_outcome(market: dict[str, Any]) -> tuple[str | None, float | None]:
    """Get the most likely outcome and its probability from a market"""
    outcomes = market.get('outcomes')
    prices = market.get('outcomePrices')

    if not outcomes or not prices:
        return None, None

    try:
        # Parse if they're JSON strings
        if isinstance(outcomes, str):
            outcomes = json.loads(outcomes)
        if isinstance(prices, str):
            prices = json.loads(prices)

        if not isinstance(outcomes, list) or not isinstance(prices, list):
            return None, None

        if len(outcomes) != len(prices):
            return None, None

        # Find the outcome with the highest probability
        max_prob = 0
        max_outcome = None

        for outcome, price in zip(outcomes, prices):
            prob = float(price) * 100
            if prob > max_prob:
                max_prob = prob
                max_outcome = outcome

        return max_outcome, max_prob

    except (ValueError, TypeError, IndexError, json.JSONDecodeError):
        return None, None

class MarketInput(BaseModel):
    """Input format for a market to convert"""
    question: str = Field(description="The prediction market question")
    most_likely_outcome: str = Field(description="The most likely outcome (e.g., 'Yes', 'No', or specific option)")
    probability: float = Field(description="Probability percentage (0-100)")

class MarketStatement(BaseModel):
    """Output format with declarative statement and category"""
    statement: str = Field(description="Declarative statement based on most likely outcome")
    category: str = Field(description="Market category: Politics, Sports, Crypto, Economics, Entertainment, Geopolitics, Technology, or Other")

def generate_statements(markets: list[dict[str, Any]]) -> list[MarketStatement]:
    """Use LLM to convert questions to declarative statements"""
    if not markets:
        return []

    # Load API key from environment
    api_key = os.getenv('GOOGLE_API_KEY')
    if not api_key:
        raise ValueError("GOOGLE_API_KEY not found in environment")

    # Prepare input data
    market_inputs = []
    for market in markets:
        most_likely_outcome, probability = get_most_likely_outcome(market)
        if most_likely_outcome and probability is not None:
            market_inputs.append(MarketInput(
                question=market.get('question', ''),
                most_likely_outcome=most_likely_outcome,
                probability=probability
            ))

    if not market_inputs:
        return []

    # Create prompt for batch processing
    prompt = """Convert each prediction market question into a declarative statement and classify its category.

Rules:
- Yes outcome → "[subject] will [verb]"
- No outcome → "[subject] will not [verb]"
- Remove question marks
- Preserve capitalization (GDP, Q1, AI, etc.) and special symbols (≥, %, etc.)

Categories (choose one):
- Politics: Elections, politicians, government positions, legislation
- Sports: Athletes, teams, championships, sporting events
- Crypto: Bitcoin, Ethereum, cryptocurrencies, blockchain
- Economics: Fed, inflation, GDP, interest rates, stock markets
- Entertainment: Movies, box office, celebrities, awards
- Geopolitics: Wars, invasions, international conflicts, leaders
- Technology: AI achievements, tech companies, product launches
- Other: Anything that doesn't fit above categories

Examples:
- "Will Trump win?" + Yes → Statement: "Trump will win." Category: "Politics"
- "Will Bitcoin reach $150k?" + No → Statement: "Bitcoin will not reach $150k." Category: "Crypto"
- "Russia x Ukraine ceasefire?" + No → Statement: "There will not be a Russia x Ukraine ceasefire." Category: "Geopolitics"

Markets to convert:
"""

    # Add market data to prompt
    for i, m in enumerate(market_inputs, 1):
        prompt += f"\n{i}. Question: {m.question}"
        prompt += f"\n   Outcome: {m.most_likely_outcome} ({m.probability:.1f}%)\n"

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config={
                "response_mime_type": "application/json",
                "response_schema": list[MarketStatement],
                "temperature": 0.3,  # Lower temperature for more consistent output
            },
        )

        # Parse response with type checking
        if not isinstance(response.parsed, list):
            raise ValueError(f"Expected list but got {type(response.parsed)}")

        statements: list[MarketStatement] = response.parsed

        # Verify we got the right number of statements
        if len(statements) != len(market_inputs):
            print(f"⚠️  Warning: Expected {len(market_inputs)} statements but got {len(statements)}")
            # Fall back to simple conversion for any missing
            while len(statements) < len(market_inputs):
                idx = len(statements)
                m = market_inputs[idx]
                statements.append(MarketStatement(
                    statement=f"{m.question.rstrip('?')}.",
                    category='Other'
                ))

        return statements

    except Exception as e:
        print(f"❌ Error generating statements with LLM: {e}")
        print("   Falling back to simple conversion...")
        # Fallback: simple conversion
        return [
            MarketStatement(
                statement=f"{m.question.rstrip('?')}.",
                category='Other'
            )
            for m in market_inputs
        ]

def calculate_price_changes(market: dict[str, Any], historical_snapshots: dict[str, str | dict[str, Any] | None]) -> dict[str, float | None]:
    """Calculate price changes for a market"""
    changes: dict[str, float | None] = {
        'hour1': None,
        'hours24': None,
        'days7': None
    }

    current_price = None
    if market.get('outcomePrices'):
        try:
            prices = market['outcomePrices']
            # Parse if it's a JSON string
            if isinstance(prices, str):
                prices = json.loads(prices)
            current_price = float(prices[0]) * 100  # Convert to percentage
        except (ValueError, TypeError, IndexError, json.JSONDecodeError):
            return changes

    if current_price is None:
        return changes

    market_id = market.get('id')
    if not market_id:
        return changes

    # Calculate changes for each period
    for period, snapshot_data in historical_snapshots.items():
        if not snapshot_data or not isinstance(snapshot_data, dict):
            continue

        if not snapshot_data.get('markets'):
            continue

        # O(1) dictionary lookup instead of linear search through all markets
        historical_market = snapshot_data['markets'].get(market_id)

        if historical_market and historical_market.get('outcomePrices'):
            try:
                prices = historical_market['outcomePrices']
                # Parse if it's a JSON string
                if isinstance(prices, str):
                    prices = json.loads(prices)
                historical_price = float(prices[0]) * 100
                price_change = current_price - historical_price
                changes[period] = round(price_change, 2)
            except (ValueError, TypeError, IndexError, json.JSONDecodeError):
                continue

    return changes

def load_previous_markets() -> dict[str, dict[str, Any]]:
    """Load all previously saved markets into a lookup dictionary"""
    if not os.path.exists(OUTPUT_FILE):
        return {}

    try:
        with open(OUTPUT_FILE, 'r') as f:
            data = json.load(f)
            if not data.get('markets'):
                return {}

            # Create a lookup dictionary by market ID
            return {m.get('id'): m for m in data['markets'] if m.get('id')}
    except Exception:
        return {}

    return {}

def deduplicate_related_markets(markets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Deduplicate markets that are part of the same event (e.g., multiple candidates for same election).

    Markets with the same negRiskMarketID represent different outcomes of the same event.
    We keep only the most likely outcome from each group.
    """
    from collections import defaultdict

    # Group markets by negRiskMarketID
    groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    standalone_markets: list[dict[str, Any]] = []

    for market in markets:
        neg_risk_id = market.get('negRiskMarketID')

        if neg_risk_id:
            # Part of a multi-outcome group (e.g., different candidates in same election)
            groups[neg_risk_id].append(market)
        else:
            # Standalone binary market
            standalone_markets.append(market)

    # For each group, select the best representative
    deduplicated: list[dict[str, Any]] = []

    for neg_risk_id, group_markets in groups.items():
        if len(group_markets) == 1:
            # Only one market in group (edge case)
            deduplicated.append(group_markets[0])
        else:
            # Select market with highest "Yes" probability (most likely to happen)
            yes_markets = [m for m in group_markets if m.get('mostLikelyOutcome') == 'Yes']

            if yes_markets:
                # Pick the one with highest probability
                best = max(yes_markets, key=lambda m: m.get('currentProbability', 0))
                print(f"  ✓ Grouped event: Keeping \"{best.get('question', '')[:60]}...\" ({round(best.get('currentProbability', 0), 1)}%)")
            else:
                # All are "No" (uncertain event) - keep highest volume
                best = max(group_markets, key=lambda m: float(m.get('volume', 0)))
                print(f"  ⚠️  Uncertain event: Keeping highest volume - \"{best.get('question', '')[:60]}...\"")

            deduplicated.append(best)

    # Add standalone markets
    deduplicated.extend(standalone_markets)

    return deduplicated

def filter_and_sort_markets(markets: list[dict[str, Any]], historical_snapshots: dict[str, str | dict[str, Any] | None]) -> list[dict[str, Any]]:
    """Filter markets closing in next 90 days and sort by volume"""
    now = datetime.now(UTC)

    filtered = []

    print("🔄 Filtering and processing markets...")

    # Load previous market data ONCE for O(1) lookups
    previous_markets = load_previous_markets()
    print(f"  📖 Loaded {len(previous_markets)} previous markets for comparison")

    # First pass: filter active markets closing in next 90 days with valid outcome data
    for market in markets:
        if not market.get('endDateIso') or not market.get('active') or market.get('closed'):
            continue

        try:
            # Parse endDateIso (format: YYYY-MM-DD) as a UTC date at midnight
            end_date_str = market['endDateIso']
            if 'T' in end_date_str:
                # Full datetime string
                end_date = datetime.fromisoformat(end_date_str.replace('Z', '+00:00'))
            else:
                # Date only - assume midnight UTC
                end_date = datetime.fromisoformat(end_date_str + 'T00:00:00+00:00')

            days_until_end = (end_date - now).days

            if 0 < days_until_end <= 90:
                # Get the most likely outcome and its probability
                most_likely_outcome, current_probability = get_most_likely_outcome(market)

                if most_likely_outcome is None or current_probability is None:
                    # Skip markets without valid outcome data
                    continue

                # Store for future use (defer price changes until after deduplication)
                market['mostLikelyOutcome'] = most_likely_outcome
                market['currentProbability'] = current_probability

                # Extract event slug from events array for correct URL generation
                event_slug = None
                if market.get('events') and isinstance(market['events'], list) and len(market['events']) > 0:
                    event_slug = market['events'][0].get('slug')
                market['eventSlug'] = event_slug

                filtered.append(market)
        except (ValueError, TypeError) as e:
            continue

    print(f"  Found {len(filtered)} markets closing in next 90 days")

    # Second pass: Deduplicate BEFORE generating statements (efficiency!)
    print("\n🔗 Deduplicating related markets...")
    filtered = deduplicate_related_markets(filtered)
    print(f"  After deduplication: {len(filtered)} unique events")

    # Calculate price changes only for deduplicated markets (saves ~40% calculations)
    print("  📊 Calculating price changes for deduplicated markets...")
    for market in filtered:
        market['priceChanges'] = calculate_price_changes(market, historical_snapshots)

    # Third pass: Check previous markets.json for existing classifications
    markets_needing_statements = []
    market_indices = []

    for i, market in enumerate(filtered):
        market_id = market.get('id', '')
        previous_data = previous_markets.get(market_id)

        # Check if we already have a classification with the same outcome
        if previous_data and previous_data.get('mostLikelyOutcome') == market['mostLikelyOutcome']:
            # Reuse existing classification
            market['statement'] = previous_data.get('statement', market.get('question'))
            market['displayProbability'] = round(market['currentProbability'], 1)
            market['category'] = previous_data.get('category', 'Other')
        else:
            # New market or outcome changed, need to generate
            markets_needing_statements.append(market)
            market_indices.append(i)

    # Fourth pass: Batch generate statements only for markets that need them
    if markets_needing_statements:
        print(f"  🤖 Generating {len(markets_needing_statements)} new statements with LLM...")
        try:
            statements = generate_statements(markets_needing_statements)

            # Assign statements and categories back to markets
            for i, statement_obj in enumerate(statements):
                market_idx = market_indices[i]
                market = filtered[market_idx]
                market['statement'] = statement_obj.statement
                market['displayProbability'] = round(market['currentProbability'], 1)
                market['category'] = statement_obj.category

        except Exception as e:
            print(f"  ⚠️  Error in batch generation: {e}")
            # Fallback: use question as statement and default category
            for i, market in enumerate(markets_needing_statements):
                market_idx = market_indices[i]
                filtered[market_idx]['statement'] = market.get('question', '').rstrip('?') + '.'
                filtered[market_idx]['displayProbability'] = round(market['currentProbability'], 1)
                filtered[market_idx]['category'] = 'Other'
    else:
        print(f"  ✅ All {len(filtered)} markets found in previous data, no LLM calls needed!")

    # Sort by volume (highest first)
    filtered.sort(key=lambda x: float(x.get('volume', 0)), reverse=True)

    # Return all filtered markets (frontend will display top 50)
    return filtered

def save_markets(markets: list[dict[str, Any]]) -> None:
    """Save markets to JSON file"""
    data = {
        'lastUpdated': datetime.now(UTC).isoformat() + 'Z',
        'marketCount': len(markets),
        'markets': markets
    }

    with open(OUTPUT_FILE, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"✅ Saved {len(markets)} markets to {OUTPUT_FILE}")

def save_historical_snapshot(markets: list[dict[str, Any]]) -> None:
    """Save a snapshot for historical price tracking"""
    timestamp = datetime.now(UTC).strftime('%Y-%m-%d_%H-%M')
    snapshot_file = os.path.join(HISTORY_DIR, f'{timestamp}.json')

    # Save full market data for historical reference
    snapshot_data = {
        'timestamp': datetime.now(UTC).isoformat() + 'Z',
        'markets': markets
    }

    with open(snapshot_file, 'w') as f:
        json.dump(snapshot_data, f)

    print(f"📸 Saved historical snapshot: {snapshot_file}")

    # Clean up old snapshots
    cleanup_old_snapshots()

def cleanup_old_snapshots() -> None:
    """Remove snapshots older than 30 days"""
    if not os.path.exists(HISTORY_DIR):
        return

    cutoff_date = datetime.now(UTC) - timedelta(days=30)
    removed_count = 0

    for filename in os.listdir(HISTORY_DIR):
        if not filename.endswith('.json'):
            continue

        try:
            timestamp_str = filename.replace('.json', '')
            file_time = datetime.strptime(timestamp_str, '%Y-%m-%d_%H-%M').replace(tzinfo=UTC)

            if file_time < cutoff_date:
                os.remove(os.path.join(HISTORY_DIR, filename))
                removed_count += 1
        except (ValueError, OSError):
            continue

    if removed_count > 0:
        print(f"🧹 Cleaned up {removed_count} old snapshots")

def main() -> None:
    ensure_directories()

    # Fetch all markets
    all_markets = fetch_all_markets()
    print(f"📊 Retrieved {len(all_markets)} total markets")

    # Save snapshot for future price change calculations
    save_historical_snapshot(all_markets)

    # Load historical snapshots for price change calculation
    historical_snapshots = load_historical_snapshots()

    # Filter and sort markets
    filtered_markets = filter_and_sort_markets(all_markets, historical_snapshots)
    print(f"✨ Final selection: {len(filtered_markets)} markets closing in next 90 days")

    # Save to main file
    save_markets(filtered_markets)
    print("🎉 Done!")

if __name__ == '__main__':
    main()
