# Polynews

Aggregates high-confidence Polymarket predictions into a minimalist news feed.

## How It Works

**Data Pipeline:** Polymarket API → Filter → LLM Processing → JSON → Static Frontend

**Filtering Criteria:**
- Active markets closing within 90 days
- "Yes" outcome with ≥55% probability
- Deduplicated (same event groups + LLM semantic redundancy check)

**LLM Processing (Gemini):**
- Converts questions to declarative statements
- Categorizes into: Politics, Sports, Crypto, Economics, Entertainment, Geopolitics, Technology, Science, Pop Culture, Legal, Conspiracy, Other

**Output:** Sorted by volume, all passing markets included (no limit).

## Usage

```bash
uv run python scripts/fetch_markets.py
```

Outputs to `docs/markets.json`. Frontend served from `docs/`.

## Caching

LLM calls are minimized via two caches:
- **Redundancy decisions:** SQLite `redundancy_cache` table (persists indefinitely)
- **Statements/categories:** Reused from previous `markets.json` if outcome unchanged

Typical runs: 0 LLM calls. New markets only trigger batch calls for redundancy check + statement generation.

## Requirements

- `GOOGLE_API_KEY` in `.env` for Gemini
