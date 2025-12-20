import json
import httpx
import asyncio
import sqlite3
import logging
from datetime import datetime, timedelta, UTC
from typing import Any
import os
import boto3
from botocore.config import Config
from google import genai
from pydantic import BaseModel, Field, field_validator, ValidationError, ConfigDict
from decimal import Decimal

logging.basicConfig(level=logging.INFO, format='%(message)s')
log = logging.getLogger(__name__)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

API_URL = "https://gamma-api.polymarket.com/markets"
OUTPUT_FILE = "docs/markets.json"
DB_FILE = "markets.db"
MODEL = "gemini-2.5-flash-lite"

class PolymarketMarket(BaseModel):
    model_config = ConfigDict(extra="allow")

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
        if isinstance(v, str):
            parsed = json.loads(v)
            if not isinstance(parsed, list):
                raise ValueError("Must be a list")
            return parsed
        if isinstance(v, list):
            return v
        raise ValueError("Must be a list or JSON string")

    @field_validator('volume', mode='before')
    @classmethod
    def validate_volume(cls, v: Any) -> str | float:
        if isinstance(v, (str, int, float)):
            try:
                float(v)
                return v
            except (ValueError, TypeError):
                return "0"
        return "0"

def init_database() -> None:
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS snapshots (
            timestamp TEXT PRIMARY KEY,
            markets_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON snapshots(timestamp)')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS redundancy_cache (
            market_id TEXT PRIMARY KEY,
            redundant_of TEXT,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()

async def fetch_page(client: httpx.AsyncClient, offset: int, limit: int) -> tuple[list[dict[str, Any]], int]:
    params = {'limit': limit, 'offset': offset, 'active': 'true', 'closed': 'false', 'archived': 'false'}
    try:
        response = await client.get(API_URL, params=params, timeout=30)
        response.raise_for_status()
        raw_data = response.json()
        validated_markets = []
        for market_data in raw_data:
            try:
                validated_markets.append(PolymarketMarket(**market_data).model_dump())
            except ValidationError:
                continue
        return validated_markets, len(raw_data)
    except (httpx.HTTPError, json.JSONDecodeError) as e:
        print(f"❌ Error fetching page at offset {offset}: {e}")
        return [], 0

async def fetch_all_markets_async() -> list[dict[str, Any]]:
    print("🔍 Fetching markets from Polymarket API...")
    limit, max_offset = 100, 500

    async with httpx.AsyncClient() as client:
        first_page, first_count = await fetch_page(client, 0, limit)
        if not first_page and first_count == 0:
            return []

        all_markets = first_page
        print(f"  📊 Fetched first page: {len(first_page)} valid markets ({first_count} returned by API)")

        if first_count == limit:
            tasks = [fetch_page(client, offset, limit) for offset in range(limit, max_offset + 1, limit)]
            for i, (page_markets, page_count) in enumerate(await asyncio.gather(*tasks)):
                if page_count > 0:
                    all_markets.extend(page_markets)
                    print(f"  📊 Fetched page {i+2}: {len(page_markets)} valid markets ({page_count} from API, total: {len(all_markets)} valid)")
                    if page_count < limit:
                        break
                else:
                    break
    return all_markets

def fetch_all_markets() -> list[dict[str, Any]]:
    return asyncio.run(fetch_all_markets_async())

def load_historical_snapshots() -> dict[str, str | dict[str, Any] | None]:
    snapshots: dict[str, str | dict[str, Any] | None] = {'hour1': None, 'hours24': None, 'days7': None}
    if not os.path.exists(DB_FILE):
        return snapshots

    now = datetime.now(UTC)
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) FROM snapshots')
    total_snapshots = cursor.fetchone()[0]

    min_ages = {'hour1': timedelta(hours=1), 'hours24': timedelta(hours=24), 'days7': timedelta(days=7)}
    cursor.execute('SELECT timestamp, markets_json FROM snapshots ORDER BY timestamp DESC')

    for timestamp_str, markets_json in cursor.fetchall():
        try:
            snapshot_time = datetime.strptime(timestamp_str, '%Y-%m-%d_%H-%M').replace(tzinfo=UTC)
            age = now - snapshot_time
            for period, min_age in min_ages.items():
                if snapshots[period] is None and age >= min_age:
                    markets_list = json.loads(markets_json)
                    snapshots[period] = {
                        'timestamp': timestamp_str,
                        'markets': {m.get('id'): m for m in markets_list if m.get('id')}
                    }
            if all(snapshots.values()):
                break
        except (ValueError, json.JSONDecodeError):
            continue

    conn.close()
    loaded = [k for k, v in snapshots.items() if v is not None]
    if loaded:
        print(f"Loaded snapshots: {', '.join(loaded)} (total: {total_snapshots})")
    elif total_snapshots > 0:
        print(f"No snapshots old enough yet ({total_snapshots} snapshots = {total_snapshots * 0.25:.1f}hr history)")
    return snapshots

def get_most_likely_outcome(market: dict[str, Any]) -> tuple[str | None, float | None]:
    outcomes, prices = market.get('outcomes'), market.get('outcomePrices')
    if not outcomes or not prices:
        return None, None
    try:
        if isinstance(outcomes, str):
            outcomes = json.loads(outcomes)
        if isinstance(prices, str):
            prices = json.loads(prices)
        if not isinstance(outcomes, list) or not isinstance(prices, list) or len(outcomes) != len(prices):
            return None, None
        max_prob, max_outcome = 0, None
        for outcome, price in zip(outcomes, prices):
            prob = float(price) * 100
            if prob > max_prob:
                max_prob, max_outcome = prob, outcome
        return max_outcome, max_prob
    except (ValueError, TypeError, IndexError, json.JSONDecodeError):
        return None, None

class MarketInput(BaseModel):
    question: str
    most_likely_outcome: str
    probability: float
    event_title: str | None = None

class MarketStatement(BaseModel):
    statement: str
    category: str

class RedundancyResult(BaseModel):
    redundant_market_ids: list[str]
    reasoning: list[str]

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
            events = market.get('events')
            event_title = events[0].get('title') if events and isinstance(events, list) and events else None
            market_inputs.append(MarketInput(
                question=market.get('question', ''),
                most_likely_outcome=most_likely_outcome,
                probability=probability,
                event_title=event_title
            ))

    if not market_inputs:
        return []

    # Create prompt for batch processing
    prompt = """Convert each prediction market question into a concise declarative statement and classify its category.

Rules:
- Convert question to short affirmative statement: "[subject] will [verb]"
- CRITICAL: When an Event title is provided, you MUST incorporate key details (company names, person names, specific context) from it into the statement. The statement must be understandable without seeing the event title.
- Be concise: remove filler words, unnecessary dates, and verbose phrases
- Remove question marks, preserve capitalization (GDP, Q1, AI) and symbols (≥, %)

Categories (use existing when possible, create new ones if nothing fits):
- Politics: Elections, politicians, legislation
- Sports: Athletes, teams, championships
- Crypto: Bitcoin, Ethereum, blockchain
- Economics: Fed, inflation, GDP, interest rates
- Business: Corporate leadership, M&A, company announcements
- Entertainment: Movies, celebrities, awards
- Geopolitics: Wars, conflicts, leaders
- Technology: AI, tech companies, product launches
- Science: Climate, health, space, disasters
- Pop Culture: Celebrity relationships, wealth
- Legal: Trials, lawsuits, verdicts
- Conspiracy: Fringe theories, supernatural

IMPORTANT: Never use "Other" as a category. If no existing category fits, create a descriptive new category name.

Examples:
- Question: "Will Trump win the 2024 presidential election?" → Statement: "Trump will win 2024 election." Category: "Politics"
- Question: "Will Bitcoin reach $150k by end of year?" → Statement: "Bitcoin will hit $150k." Category: "Crypto"
- Question: "Will NVIDIA be the largest company in the world by market cap on December 31?" → Statement: "NVIDIA will be largest company by market cap." Category: "Technology"
- Question: "Will Luigi Mangione be found guilty?" → Statement: "Luigi Mangione will be found guilty." Category: "Legal"
- Question: "Will no CEO be announced in 2025?", Event: "Who will replace Musk as Tesla CEO?" → Statement: "No Musk replacement as Tesla CEO will be announced in 2025." Category: "Business"

Markets to convert:
"""

    # Add market data to prompt
    for i, m in enumerate(market_inputs, 1):
        prompt += f"\n{i}. Question: {m.question}"
        if m.event_title and m.event_title != m.question:
            prompt += f"\n   Event: {m.event_title}"
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
                    category='Uncategorized'
                ))

        return statements

    except Exception as e:
        print(f"❌ Error generating statements with LLM: {e}")
        print("   Falling back to simple conversion...")
        # Fallback: simple conversion
        return [MarketStatement(statement=f"{m.question.rstrip('?')}.", category='Uncategorized') for m in market_inputs]

def load_redundancy_cache() -> dict[str, str | None]:
    if not os.path.exists(DB_FILE):
        return {}
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT market_id, redundant_of FROM redundancy_cache')
        return {row[0]: row[1] for row in cursor.fetchall()}
    except sqlite3.OperationalError:
        return {}
    finally:
        conn.close()

def save_redundancy_cache(decisions: dict[str, tuple[str | None, str]]) -> None:
    if not decisions:
        return
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.executemany(
        'INSERT OR REPLACE INTO redundancy_cache (market_id, redundant_of, reason) VALUES (?, ?, ?)',
        [(mid, red_of, reason) for mid, (red_of, reason) in decisions.items()]
    )
    conn.commit()
    conn.close()

def check_redundancy_llm(
    new_markets: list[dict[str, Any]],
    existing_markets: list[dict[str, Any]] | None = None
) -> dict[str, tuple[str | None, str]]:
    if not new_markets:
        return {}

    api_key = os.getenv('GOOGLE_API_KEY')
    if not api_key:
        print("⚠️  GOOGLE_API_KEY not found, skipping redundancy check")
        return {m.get('id'): (None, "no api key") for m in new_markets}

    prompt = """Identify REDUNDANT predictions that should be removed.

A prediction is REDUNDANT if another prediction logically implies it - if one is true, the other MUST also be true.

Examples of redundancy:
- "Gold above $4,000" makes "Gold above $3,200" redundant (higher implies lower)
- "Bitcoin hits $200k" makes "Bitcoin hits $150k" redundant
- "BTC reaches $100k by June" makes "BTC reaches $100k by December" redundant (earlier implies later)
- "Team X wins championship" makes "Team X reaches finals" redundant

NOT redundant (keep both):
- Different subjects: "Gold above $4000" vs "Silver above $50"
- Different directions: "Gold above $3000" vs "Gold below $4000"
- Different specific times: "BTC price on June 30" vs "BTC price on Dec 31"
- Unrelated: "Trump wins election" vs "Republicans win House"

Return IDs of predictions to REMOVE. When in doubt, keep both.

"""
    if existing_markets:
        prompt += "EXISTING PREDICTIONS (for reference):\n"
        for m in existing_markets:
            prompt += f"- [{m.get('id')}] {m.get('question')} ({m.get('currentProbability', 0):.1f}%)\n"
        prompt += "\nNEW PREDICTIONS TO CHECK:\n"
    else:
        prompt += "PREDICTIONS TO CHECK:\n"

    for m in new_markets:
        prompt += f"- [{m.get('id')}] {m.get('question')} ({m.get('currentProbability', 0):.1f}%)\n"

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config={"response_mime_type": "application/json", "response_schema": RedundancyResult, "temperature": 0.1},
        )
        result = response.parsed
        if not isinstance(result, RedundancyResult):
            raise ValueError(f"Expected RedundancyResult but got {type(result)}")

        redundant_ids = set(result.redundant_market_ids)
        decisions: dict[str, tuple[str | None, str]] = {}
        for i, m in enumerate(new_markets):
            mid = m.get('id')
            if mid in redundant_ids:
                reason = result.reasoning[i] if i < len(result.reasoning) else "redundant"
                decisions[mid] = ("redundant", reason)
            else:
                decisions[mid] = (None, "not redundant")
        return decisions
    except Exception as e:
        print(f"❌ Error in redundancy LLM call: {e}")
        return {m.get('id'): (None, f"error: {e}") for m in new_markets}

def deduplicate_semantic_redundancy(markets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(markets) < 2:
        return markets

    cache = load_redundancy_cache()
    cached_markets, new_markets = [], []

    for m in markets:
        mid = m.get('id')
        if mid in cache:
            if cache[mid] is None:
                cached_markets.append(m)
        else:
            new_markets.append(m)

    if not new_markets:
        print(f"  ✓ Redundancy check: using cached decisions ({len(cached_markets)} kept)")
        return cached_markets

    print(f"  Checking {len(new_markets)} new markets for redundancy...")

    decisions = check_redundancy_llm(new_markets, cached_markets) if cached_markets else check_redundancy_llm(new_markets)
    save_redundancy_cache(decisions)

    kept_new = [m for m in new_markets if decisions.get(m.get('id'), (None,))[0] is None]
    removed_count = len(new_markets) - len(kept_new)
    if removed_count > 0:
        print(f"  ✓ Removed {removed_count} redundant predictions")
    return cached_markets + kept_new

def calculate_price_changes(market: dict[str, Any], historical_snapshots: dict[str, str | dict[str, Any] | None]) -> dict[str, float | None]:
    changes: dict[str, float | None] = {'hour1': None, 'hours24': None, 'days7': None}
    try:
        prices = market.get('outcomePrices')
        if isinstance(prices, str):
            prices = json.loads(prices)
        current_price = float(prices[0]) * 100
    except (ValueError, TypeError, IndexError, json.JSONDecodeError, AttributeError):
        return changes

    market_id = market.get('id')
    if not market_id:
        return changes

    for period, snapshot_data in historical_snapshots.items():
        if not snapshot_data or not isinstance(snapshot_data, dict) or not snapshot_data.get('markets'):
            continue
        historical_market = snapshot_data['markets'].get(market_id)
        if historical_market and historical_market.get('outcomePrices'):
            try:
                hist_prices = historical_market['outcomePrices']
                if isinstance(hist_prices, str):
                    hist_prices = json.loads(hist_prices)
                changes[period] = round(current_price - float(hist_prices[0]) * 100, 2)
            except (ValueError, TypeError, IndexError, json.JSONDecodeError):
                continue
    return changes

def load_previous_markets() -> dict[str, dict[str, Any]]:
    if not os.path.exists(OUTPUT_FILE):
        return {}
    try:
        with open(OUTPUT_FILE, 'r') as f:
            data = json.load(f)
            return {m.get('id'): m for m in data.get('markets', []) if m.get('id')}
    except Exception:
        return {}

def deduplicate_related_markets(markets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate markets with same negRiskMarketID, keeping the most likely outcome."""
    from collections import defaultdict

    groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    standalone_markets: list[dict[str, Any]] = []

    for market in markets:
        neg_risk_id = market.get('negRiskMarketID')
        if neg_risk_id:
            groups[neg_risk_id].append(market)
        else:
            standalone_markets.append(market)

    deduplicated: list[dict[str, Any]] = []
    for group_markets in groups.values():
        if len(group_markets) == 1:
            deduplicated.append(group_markets[0])
        else:
            yes_markets = [m for m in group_markets if m.get('mostLikelyOutcome') == 'Yes']
            if yes_markets:
                best = max(yes_markets, key=lambda m: m.get('currentProbability', 0))
                print(f"  ✓ Grouped event: Keeping \"{best.get('question', '')[:60]}...\" ({round(best.get('currentProbability', 0), 1)}%)")
            else:
                best = max(group_markets, key=lambda m: float(m.get('volume', 0)))
                print(f"  ⚠️  Uncertain event: Keeping highest volume - \"{best.get('question', '')[:60]}...\"")
            deduplicated.append(best)

    deduplicated.extend(standalone_markets)
    return deduplicated

def filter_and_sort_markets(markets: list[dict[str, Any]], historical_snapshots: dict[str, str | dict[str, Any] | None]) -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    filtered = []
    previous_markets = load_previous_markets()

    # Track filtering reasons
    skip_reasons = {'no_end_date': 0, 'inactive': 0, 'closed': 0, 'date_range': 0, 'outcome_no': 0, 'prob_low': 0, 'parse_err': 0}

    for market in markets:
        if not market.get('endDateIso'):
            skip_reasons['no_end_date'] += 1
            continue
        if not market.get('active'):
            skip_reasons['inactive'] += 1
            continue
        if market.get('closed'):
            skip_reasons['closed'] += 1
            continue
        try:
            end_date_str = market['endDateIso']
            end_date = datetime.fromisoformat(
                end_date_str.replace('Z', '+00:00') if 'T' in end_date_str else end_date_str + 'T00:00:00+00:00'
            )
            days_until_end = (end_date - now).days
            if not (0 < days_until_end <= 90):
                skip_reasons['date_range'] += 1
                continue

            most_likely_outcome, current_probability = get_most_likely_outcome(market)
            if most_likely_outcome is None or current_probability is None:
                skip_reasons['parse_err'] += 1
                continue
            if most_likely_outcome == 'No':
                skip_reasons['outcome_no'] += 1
                continue
            if current_probability < 55:
                skip_reasons['prob_low'] += 1
                continue

            market['mostLikelyOutcome'] = most_likely_outcome
            market['currentProbability'] = current_probability
            events = market.get('events')
            market['eventSlug'] = events[0].get('slug') if events and isinstance(events, list) and events else None
            filtered.append(market)
        except (ValueError, TypeError):
            skip_reasons['parse_err'] += 1
            continue

    log.info(f"Filter: {len(markets)} raw → {len(filtered)} after basic (skipped: {skip_reasons})")

    before = len(filtered)
    filtered = deduplicate_related_markets(filtered)
    log.info(f"Filter: {before} → {len(filtered)} after related dedup (-{before - len(filtered)})")

    before = len(filtered)
    filtered = deduplicate_semantic_redundancy(filtered)
    log.info(f"Filter: {before} → {len(filtered)} after semantic dedup (-{before - len(filtered)})")

    for market in filtered:
        market['priceChanges'] = calculate_price_changes(market, historical_snapshots)

    markets_needing_statements, market_indices = [], []
    for i, market in enumerate(filtered):
        previous_data = previous_markets.get(market.get('id', ''))
        if previous_data and previous_data.get('mostLikelyOutcome') == market['mostLikelyOutcome']:
            market['statement'] = previous_data.get('statement', market.get('question'))
            market['displayProbability'] = round(market['currentProbability'])
            market['category'] = previous_data.get('category', 'Uncategorized')
        else:
            markets_needing_statements.append(market)
            market_indices.append(i)

    if markets_needing_statements:
        print(f"Generating {len(markets_needing_statements)} statements via LLM...")
        try:
            statements = generate_statements(markets_needing_statements)
            for i, statement_obj in enumerate(statements):
                market = filtered[market_indices[i]]
                market['statement'] = statement_obj.statement
                market['displayProbability'] = round(market['currentProbability'])
                market['category'] = statement_obj.category
        except Exception as e:
            print(f"LLM generation failed: {e}, using fallback")
            for i, market in enumerate(markets_needing_statements):
                filtered[market_indices[i]]['statement'] = market.get('question', '').rstrip('?') + '.'
                filtered[market_indices[i]]['displayProbability'] = round(market['currentProbability'])
                filtered[market_indices[i]]['category'] = 'Uncategorized'

    filtered.sort(key=lambda x: float(x.get('volume', 0)), reverse=True)
    return filtered

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)

def upload_to_r2(data: dict[str, Any]) -> bool:
    """Upload markets.json to Cloudflare R2 bucket."""
    account_id = os.getenv('CLOUDFLARE_ACCOUNT_ID')
    access_key = os.getenv('R2_ACCESS_KEY_ID')
    secret_key = os.getenv('R2_SECRET_ACCESS_KEY')
    bucket_name = os.getenv('R2_BUCKET_NAME', 'polynews')

    if not all([account_id, access_key, secret_key]):
        print("⚠️  R2 credentials not found, skipping upload")
        return False

    try:
        s3 = boto3.client(
            's3',
            endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version='s3v4'),
        )

        json_data = json.dumps(data, cls=DecimalEncoder)
        s3.put_object(
            Bucket=bucket_name,
            Key='markets.json',
            Body=json_data,
            ContentType='application/json',
        )
        print(f"✅ Uploaded to R2: {bucket_name}/markets.json")
        return True
    except Exception as e:
        print(f"❌ R2 upload failed: {e}")
        return False

def save_markets(markets: list[dict[str, Any]]) -> None:
    data = {'lastUpdated': datetime.now(UTC).isoformat().replace('+00:00', 'Z'), 'marketCount': len(markets), 'markets': markets}

    # Save locally
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(data, f, indent=2, cls=DecimalEncoder)

    # Upload to R2
    upload_to_r2(data)

def save_historical_snapshot(markets: list[dict[str, Any]]) -> None:
    timestamp = datetime.now(UTC).strftime('%Y-%m-%d_%H-%M')
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('INSERT OR REPLACE INTO snapshots (timestamp, markets_json) VALUES (?, ?)',
                   (timestamp, json.dumps(markets, cls=DecimalEncoder)))
    conn.commit()
    conn.close()
    cleanup_old_snapshots()

def cleanup_old_snapshots() -> None:
    if not os.path.exists(DB_FILE):
        return
    cutoff = (datetime.now(UTC) - timedelta(days=30)).strftime('%Y-%m-%d_%H-%M')
    conn = sqlite3.connect(DB_FILE)
    conn.execute('DELETE FROM snapshots WHERE timestamp < ?', (cutoff,))
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
