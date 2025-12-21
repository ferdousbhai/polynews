-- Snapshots table for price history tracking
CREATE TABLE IF NOT EXISTS snapshots (
    timestamp TEXT PRIMARY KEY,
    markets_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON snapshots(timestamp);

-- Redundancy cache for LLM decisions
CREATE TABLE IF NOT EXISTS redundancy_cache (
    market_id TEXT PRIMARY KEY,
    redundant_of TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Statement cache for LLM-generated statements
CREATE TABLE IF NOT EXISTS statement_cache (
    market_id TEXT PRIMARY KEY,
    statement TEXT NOT NULL,
    category TEXT NOT NULL,
    most_likely_outcome TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
