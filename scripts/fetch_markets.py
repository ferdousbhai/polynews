import json
import httpx
import asyncio
import sqlite3
from datetime import datetime, timedelta, UTC
from typing import Union, Any
import os
from pathlib import Path
from google import genai
from pydantic import BaseModel, Field, field_validator, ValidationError, ConfigDict
from decimal import Decimal

# Load environment variables (only for local development)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed (e.g., in GitHub Actions)

API_URL = "https://gamma-api.polymarket.com/markets"
OUTPUT_FILE = "docs/markets.json"
DB_FILE = "markets.db"
TIME_WINDOW = timedelta(days=90)
MODEL = "gemini-2.5-flash-lite"

# Pydantic models for API validation
class PolymarketEvent(BaseModel):
    """Event information from Polymarket API"""
    model_config = ConfigDict(extra="allow")  # Allow additional fields from API

    slug: str | None = None
    # Other fields exist but we only need slug

class PolymarketMarket(BaseModel):
    """Market data structure from Polymarket API"""
    model_config = ConfigDict(extra="allow")  # Allow additional fields from API that we don't explicitly need

    id: str
    question: str
    endDateIso: str
    active: bool
    closed: bool
    archived: bool | None = None
    volume: str | float
    liquidity: str | float | None = None
    outcomePrices: list[str] | str
    outcomes: list[str] | str
    negRiskMarketID: str | None = None
    events: list[dict[str, Any]] | None = None
    slug: str | None = None
    description: str | None = None

    @field_validator('outcomePrices', 'outcomes', mode='before')
    @classmethod
    def parse_json_strings(cls, v: Any) -> list[str]:
        """Parse JSON strings to lists"""
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                if not isinstance(parsed, list):
                    raise ValueError("Must be a list")
                return parsed
            except json.JSONDecodeError:
                raise ValueError("Invalid JSON string")
        if isinstance(v, list):
            return v
        raise ValueError("Must be a list or JSON string")

    @field_validator('volume', mode='before')
    @classmethod
    def validate_volume(cls, v: Any) -> str | float:
        """Ensure volume is a valid number"""
        if isinstance(v, (str, int, float)):
            try:
                float(v)
                return v
            except (ValueError, TypeError):
                return "0"
        return "0"

def init_database() -> None:
    """Initialize SQLite database for history snapshots"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS snapshots (
            timestamp TEXT PRIMARY KEY,
            markets_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_timestamp ON snapshots(timestamp)
    ''')

    conn.commit()
    conn.close()

async def fetch_page(client: httpx.AsyncClient, offset: int, limit: int) -> tuple[list[dict[str, Any]], int]:
    """Fetch a single page of markets with validation

    Returns:
        tuple: (validated_markets, raw_api_count) where raw_api_count is how many markets the API returned
    """
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
        raw_data = response.json()
        raw_count = len(raw_data)

        # Validate each market with Pydantic
        validated_markets = []
        validation_errors = 0

        for i, market_data in enumerate(raw_data):
            try:
                # Validate market structure
                validated_market = PolymarketMarket(**market_data)
                # Convert back to dict for downstream processing
                validated_markets.append(validated_market.model_dump())
            except ValidationError as e:
                validation_errors += 1
                continue

        return validated_markets, raw_count

    except httpx.HTTPError as e:
        print(f"❌ HTTP error fetching page at offset {offset}: {e}")
        return [], 0
    except json.JSONDecodeError as e:
        print(f"❌ Invalid JSON response at offset {offset}: {e}")
        return [], 0
    except Exception as e:
        print(f"❌ Unexpected error fetching page at offset {offset}: {e}")
        return [], 0

async def fetch_all_markets_async() -> list[dict[str, Any]]:
    """Fetch all active markets from Polymarket API using async parallel requests"""
    print("🔍 Fetching markets from Polymarket API...")

    limit = 100
    safety_limit = 500  # Max offset

    async with httpx.AsyncClient() as client:
        # First, fetch the first page to see how many markets we need
        first_page, first_page_raw_count = await fetch_page(client, 0, limit)

        if not first_page and first_page_raw_count == 0:
            return []

        all_markets = first_page
        print(f"  📊 Fetched first page: {len(first_page)} valid markets ({first_page_raw_count} returned by API)")

        # If API returned a full page (100 markets), there might be more pages
        if first_page_raw_count == limit:
            # Create tasks for remaining pages (up to safety limit)
            tasks = []
            for offset in range(limit, safety_limit + 1, limit):
                tasks.append(fetch_page(client, offset, limit))

            # Fetch all pages in parallel
            results = await asyncio.gather(*tasks)

            # Collect all results
            for i, (page_markets, page_raw_count) in enumerate(results):
                if page_raw_count > 0:
                    all_markets.extend(page_markets)
                    print(f"  📊 Fetched page {i+2}: {len(page_markets)} valid markets ({page_raw_count} from API, total: {len(all_markets)} valid)")
                    # Stop if API returned less than a full page
                    if page_raw_count < limit:
                        break
                else:
                    break

    return all_markets

def fetch_all_markets() -> list[dict[str, Any]]:
    """Synchronous wrapper for async fetch"""
    return asyncio.run(fetch_all_markets_async())

def load_historical_snapshots() -> dict[str, str | dict[str, Any] | None]:
    """Load recent historical snapshots from SQLite database

    For each period, takes the LATEST snapshot that's at least that old:
    - hour1: Latest snapshot >= 60 minutes old
    - hours24: Latest snapshot >= 24 hours old
    - days7: Latest snapshot >= 7 days old
    """
    snapshots: dict[str, str | dict[str, Any] | None] = {
        'hour1': None,
        'hours24': None,
        'days7': None
    }

    if not os.path.exists(DB_FILE):
        return snapshots

    now = datetime.now(UTC)
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute('SELECT COUNT(*) FROM snapshots')
    total_snapshots = cursor.fetchone()[0]

    min_ages = {
        'hour1': timedelta(hours=1),
        'hours24': timedelta(hours=24),
        'days7': timedelta(days=7)
    }

    cursor.execute('SELECT timestamp, markets_json FROM snapshots ORDER BY timestamp DESC')
    rows = cursor.fetchall()

    # For each snapshot (newest first), check if it's old enough for any period
    for timestamp_str, markets_json in rows:
        try:
            # Parse timestamp
            snapshot_time = datetime.strptime(timestamp_str, '%Y-%m-%d_%H-%M').replace(tzinfo=UTC)
            age = now - snapshot_time

            # Check each period to see if this snapshot is old enough
            for period, min_age in min_ages.items():
                # If we haven't found a snapshot for this period yet, and this one is old enough
                if snapshots[period] is None and age >= min_age:
                    # Parse markets and index by ID
                    markets_list = json.loads(markets_json)
                    indexed_markets = {
                        m.get('id'): m
                        for m in markets_list
                        if m.get('id')
                    }

                    snapshots[period] = {
                        'timestamp': timestamp_str,
                        'markets': indexed_markets
                    }

            # Stop if we have all snapshots
            if all(snapshots.values()):
                break

        except (ValueError, json.JSONDecodeError) as e:
            continue

    conn.close()

    # Log snapshot status
    loaded = [k for k, v in snapshots.items() if v is not None]
    if loaded:
        print(f"Loaded snapshots: {', '.join(loaded)} (total: {total_snapshots})")
    elif total_snapshots > 0:
        history_hrs = total_snapshots * 0.25
        print(f"No snapshots old enough yet ({total_snapshots} snapshots = {history_hrs:.1f}hr history)")

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
    category: str = Field(description="Market category: Politics, Sports, Crypto, Economics, Entertainment, Geopolitics, Technology, Science, Pop Culture, Legal, Conspiracy, or Other")

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
    prompt = """Convert each prediction market question into a concise declarative statement and classify its category.

Rules:
- Convert question to short affirmative statement: "[subject] will [verb]"
- Be concise: remove filler words, unnecessary dates, and verbose phrases
- Remove question marks, preserve capitalization (GDP, Q1, AI) and symbols (≥, %)

Categories:
- Politics: Elections, politicians, legislation
- Sports: Athletes, teams, championships
- Crypto: Bitcoin, Ethereum, blockchain
- Economics: Fed, inflation, GDP, interest rates
- Entertainment: Movies, celebrities, awards
- Geopolitics: Wars, conflicts, leaders
- Technology: AI, tech companies, launches
- Science: Climate, health, space, disasters
- Pop Culture: Celebrity relationships, wealth
- Legal: Trials, lawsuits, verdicts
- Conspiracy: Fringe theories, supernatural
- Other: Anything else

Examples:
- "Will Trump win the 2024 presidential election?" → "Trump will win 2024 election." Category: "Politics"
- "Will Bitcoin reach $150k by end of year?" → "Bitcoin will hit $150k." Category: "Crypto"
- "Will NVIDIA be the largest company in the world by market cap on December 31?" → "NVIDIA will be largest company by market cap." Category: "Technology"
- "Will Luigi Mangione be found guilty?" → "Luigi Mangione will be found guilty." Category: "Legal"

Markets to convert:
"""

    # Add market data to prompt
    for i, m in enumerate(market_inputs, 1):
        prompt += f"\n{i}. Question: {m.question}"
        prompt += f"\n   Outcome: {m.most_likely_outcome} ({m.probability:.1f}%)\n"

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=MODEL,
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
    previous_markets = load_previous_markets()

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

                # Only show predictions of things that WILL happen (newsworthy)
                # Skip "X will not happen" predictions as they're not interesting
                if most_likely_outcome != 'Yes':
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

    filtered = deduplicate_related_markets(filtered)

    for market in filtered:
        market['priceChanges'] = calculate_price_changes(market, historical_snapshots)

    markets_needing_statements = []
    market_indices = []

    for i, market in enumerate(filtered):
        market_id = market.get('id', '')
        previous_data = previous_markets.get(market_id)

        if previous_data and previous_data.get('mostLikelyOutcome') == market['mostLikelyOutcome']:
            market['statement'] = previous_data.get('statement', market.get('question'))
            market['displayProbability'] = round(market['currentProbability'], 1)
            market['category'] = previous_data.get('category', 'Other')
        else:
            markets_needing_statements.append(market)
            market_indices.append(i)

    if markets_needing_statements:
        print(f"Generating {len(markets_needing_statements)} statements via LLM...")
        try:
            statements = generate_statements(markets_needing_statements)
            for i, statement_obj in enumerate(statements):
                market_idx = market_indices[i]
                market = filtered[market_idx]
                market['statement'] = statement_obj.statement
                market['displayProbability'] = round(market['currentProbability'], 1)
                market['category'] = statement_obj.category
        except Exception as e:
            print(f"LLM generation failed: {e}, using fallback")
            for i, market in enumerate(markets_needing_statements):
                market_idx = market_indices[i]
                filtered[market_idx]['statement'] = market.get('question', '').rstrip('?') + '.'
                filtered[market_idx]['displayProbability'] = round(market['currentProbability'], 1)
                filtered[market_idx]['category'] = 'Other'

    # Sort by volume (highest first)
    filtered.sort(key=lambda x: float(x.get('volume', 0)), reverse=True)

    # Return all filtered markets (frontend will display top 50)
    return filtered

class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder to convert Decimal to float"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)

def save_markets(markets: list[dict[str, Any]]) -> None:
    """Save markets to JSON file"""
    data = {
        'lastUpdated': datetime.now(UTC).isoformat().replace('+00:00', 'Z'),
        'marketCount': len(markets),
        'markets': markets
    }

    with open(OUTPUT_FILE, 'w') as f:
        json.dump(data, f, indent=2, cls=DecimalEncoder)

def save_historical_snapshot(markets: list[dict[str, Any]]) -> None:
    """Save a snapshot to SQLite database"""
    timestamp = datetime.now(UTC).strftime('%Y-%m-%d_%H-%M')

    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Save markets as JSON string
    markets_json = json.dumps(markets, cls=DecimalEncoder)

    # Insert or replace snapshot
    cursor.execute('''
        INSERT OR REPLACE INTO snapshots (timestamp, markets_json)
        VALUES (?, ?)
    ''', (timestamp, markets_json))

    conn.commit()
    conn.close()
    cleanup_old_snapshots()

def cleanup_old_snapshots() -> None:
    """Remove snapshots older than 30 days from database"""
    if not os.path.exists(DB_FILE):
        return

    cutoff_date = datetime.now(UTC) - timedelta(days=30)
    cutoff_timestamp = cutoff_date.strftime('%Y-%m-%d_%H-%M')

    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Delete old snapshots
    cursor.execute('DELETE FROM snapshots WHERE timestamp < ?', (cutoff_timestamp,))
    removed_count = cursor.rowcount

    conn.commit()
    conn.close()

def main() -> None:
    init_database()

    all_markets = fetch_all_markets()
    print(f"Fetched {len(all_markets)} markets")

    save_historical_snapshot(all_markets)
    historical_snapshots = load_historical_snapshots()

    filtered_markets = filter_and_sort_markets(all_markets, historical_snapshots)
    save_markets(filtered_markets)
    print(f"Saved {len(filtered_markets)} markets")

if __name__ == '__main__':
    main()
