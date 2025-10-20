#!/usr/bin/env python3
import json
import httpx
from datetime import datetime, timedelta
from typing import Optional, Union, Any
import os
from pathlib import Path

API_URL = "https://gamma-api.polymarket.com/markets"
OUTPUT_FILE = "data/markets.json"
HISTORY_DIR = "data/history"
THIRTY_DAYS = timedelta(days=30)

def ensure_directories() -> None:
    """Create necessary directories"""
    Path("data").mkdir(exist_ok=True)
    Path(HISTORY_DIR).mkdir(exist_ok=True)

def fetch_all_markets() -> list[dict[str, Any]]:
    """Fetch all active markets from Polymarket API"""
    all_markets = []
    offset = 0
    limit = 100

    print("🔍 Fetching markets from Polymarket API...")

    while True:
        params = {
            'limit': limit,
            'offset': offset,
            'active': 'true',
            'closed': 'false',
            'archived': 'false'
        }

        try:
            response = httpx.get(API_URL, params=params, timeout=30)
            response.raise_for_status()
        except httpx.HTTPError as e:
            print(f"❌ Error fetching markets: {e}")
            break

        markets = response.json()

        if not markets:
            break

        all_markets.extend(markets)
        print(f"  📊 Fetched {len(all_markets)} markets so far...")

        if len(markets) < limit:
            break

        offset += limit

        # Safety limit
        if offset > 500:
            break

    return all_markets

def load_historical_snapshots() -> dict[str, Optional[Union[str, dict[str, Any]]]]:
    """Load recent historical snapshots for price change calculation"""
    snapshots: dict[str, Optional[Union[str, dict[str, Any]]]] = {
        'hour1': None,
        'hours24': None,
        'days7': None
    }

    now = datetime.utcnow()

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
            file_time = datetime.strptime(timestamp_str, '%Y-%m-%d_%H-%M')
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

    # Load the snapshot data
    for period, filename in snapshots.items():
        if filename and isinstance(filename, str):
            try:
                with open(os.path.join(HISTORY_DIR, filename), 'r') as f:
                    snapshots[period] = json.load(f)
                    print(f"  📈 Loaded {period} snapshot: {filename}")
            except Exception as e:
                print(f"  ⚠️  Could not load {filename}: {e}")
                snapshots[period] = None

    return snapshots

def calculate_price_changes(market: dict[str, Any], historical_snapshots: dict[str, Optional[Union[str, dict[str, Any]]]]) -> dict[str, Optional[float]]:
    """Calculate price changes for a market"""
    changes: dict[str, Optional[float]] = {
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

        # Find this market in historical snapshot
        historical_market = next(
            (m for m in snapshot_data['markets'] if m.get('id') == market_id),
            None
        )

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

def filter_and_sort_markets(markets: list[dict[str, Any]], historical_snapshots: dict[str, Optional[Union[str, dict[str, Any]]]]) -> list[dict[str, Any]]:
    """Filter markets closing in next 30 days and sort by volume"""
    now = datetime.utcnow()
    thirty_days_from_now = now + THIRTY_DAYS

    filtered = []

    print("🔄 Filtering and processing markets...")

    for market in markets:
        if not market.get('endDateIso') or not market.get('active') or market.get('closed'):
            continue

        try:
            end_date = datetime.fromisoformat(market['endDateIso'].replace('Z', '+00:00'))
            days_until_end = (end_date.replace(tzinfo=None) - now).days

            if 0 < days_until_end <= 30:
                # Calculate price changes
                market['priceChanges'] = calculate_price_changes(market, historical_snapshots)
                filtered.append(market)
        except (ValueError, TypeError) as e:
            continue

    # Sort by volume (highest first)
    filtered.sort(key=lambda x: float(x.get('volume', 0)), reverse=True)

    # Return top 50
    return filtered[:50]

def save_markets(markets: list[dict[str, Any]]) -> None:
    """Save markets to JSON file"""
    data = {
        'lastUpdated': datetime.utcnow().isoformat() + 'Z',
        'marketCount': len(markets),
        'markets': markets
    }

    with open(OUTPUT_FILE, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"✅ Saved {len(markets)} markets to {OUTPUT_FILE}")

def save_historical_snapshot(markets: list[dict[str, Any]]) -> None:
    """Save a snapshot for historical price tracking"""
    timestamp = datetime.utcnow().strftime('%Y-%m-%d_%H-%M')
    snapshot_file = os.path.join(HISTORY_DIR, f'{timestamp}.json')

    # Save full market data for historical reference
    snapshot_data = {
        'timestamp': datetime.utcnow().isoformat() + 'Z',
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

    cutoff_date = datetime.utcnow() - timedelta(days=30)
    removed_count = 0

    for filename in os.listdir(HISTORY_DIR):
        if not filename.endswith('.json'):
            continue

        try:
            timestamp_str = filename.replace('.json', '')
            file_time = datetime.strptime(timestamp_str, '%Y-%m-%d_%H-%M')

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
    print(f"✨ Found {len(filtered_markets)} markets closing in next 30 days")

    # Save to main file
    save_markets(filtered_markets)
    print("🎉 Done!")

if __name__ == '__main__':
    main()
