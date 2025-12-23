# Trending Detection Logic

PolyNews identifies **trending** prediction markets - those where something interesting is happening. Rather than showing all markets or only high-probability outcomes, we surface markets with significant recent changes.

## Philosophy

The goal is to show markets that provide **new information**. Drawing from:

1. **Information Theory** - Markets near 50% have maximum entropy (uncertainty), so movements there are most informative
2. **Journalism News Values** - Unexpectedness, timeliness, and significance matter
3. **Trading Momentum** - Rate of change + volume confirmation = real signal

## Filtering Pipeline

### Stage 1: Basic Filters (Worker)

Markets must pass these criteria to be considered:

| Filter | Value | Rationale |
|--------|-------|-----------|
| End date | 0-90 days | Only upcoming events |
| Active | true | Must be tradeable |
| Closed | false | Not resolved yet |
| Volume | ≥ $10,000 | Needs real market activity |
| Probability | 5-95% | Exclude essentially decided markets |

### Stage 2: Deduplication

1. **Related Markets**: Groups by `negRiskMarketID` and keeps highest probability "Yes" market
2. **Semantic Redundancy**: LLM identifies logically redundant predictions (e.g., "Bitcoin $200k" makes "$150k" redundant)

### Stage 3: Trending Score Calculation

Each market receives a trending score (0-100) based on five factors:

## Trending Score Components

### 1. Momentum (0-40 points)

Recent price movement, with 1-hour changes weighted 3× more than 24-hour:

```
momentumScore = min(40, (|change1h| × 3 + |change24h|) × 2)
```

**Rationale**: Recent momentum matters most. A market moving 3% in the last hour is more newsworthy than one that moved 3% yesterday.

### 2. Entropy Bonus (0-20 points)

Markets near 50% probability get a bonus:

```
entropy = -p × log₂(p) - (1-p) × log₂(1-p)
entropyBonus = entropy × 20
```

| Probability | Entropy | Bonus |
|-------------|---------|-------|
| 50% | 1.0 | 20 pts |
| 70% or 30% | 0.88 | 17.6 pts |
| 90% or 10% | 0.47 | 9.4 pts |
| 95% or 5% | 0.29 | 5.8 pts |

**Rationale**: A move at 50% represents genuine uncertainty shifting. A move at 90% is just noise on an already-decided outcome.

### 3. Threshold Crossing (0-20 points)

Crossing key psychological levels (25%, 50%, 75%) earns 20 bonus points:

```
if (previous < threshold && current ≥ threshold) OR
   (previous > threshold && current ≤ threshold):
   score += 20
```

**Rationale**: Crossing 50% means the market flipped from "unlikely" to "likely" - that's inherently newsworthy.

### 4. Volume Weight (0-10 points)

High-volume markets get confirmation bonus:

| Volume | Points |
|--------|--------|
| ≥ $1M | 10 |
| ≥ $100K | 5 |
| ≥ $10K | 2 |

**Rationale**: High volume means the move is backed by real money, not just a few small trades.

### 5. Sustained Trend Bonus (0-10 points)

Same direction across all timeframes (1h, 24h, 7d) with 7d change ≥ 5%:

```
if sign(change1h) = sign(change24h) = sign(change7d) AND |change7d| ≥ 5%:
   score += 10
```

**Rationale**: A sustained multi-day trend is more significant than a temporary spike.

### Penalty: Extreme Probability

Markets at >90% or <10% probability have their score halved:

```
if probability > 90% OR probability < 10%:
   score *= 0.5
```

**Rationale**: Even with movement, near-certain markets rarely provide actionable information.

## Trending Threshold

A market is considered **trending** if its score is ≥ 15.

If fewer than 3 markets are trending, the top movers by score are included as fallback.

## Display Logic

### Sorting

Markets are sorted by trending score (highest first).

### Visual Hierarchy

- **Hot** (top 3 with score ≥ 25): Orange glow, extra prominence
- **Trending** (all others): Purple accent, standard styling

### Trending Reasons

Each market displays its primary reason for trending:
- `+3.2% in 1h` - Recent momentum
- `crossed 50%` - Threshold crossing
- `high uncertainty` - Near 50% probability
- `sustained trend` - Multi-day consistent movement

## Examples

### High Score (65+ points)

```
Market: "Will X win the election?"
Probability: 48% (was 42% yesterday)
Changes: +2% (1h), +6% (24h), +12% (7d)
Volume: $5M

Score breakdown:
- Momentum: 40 pts (2×3 + 6 = 12, ×2 = 24, capped at 40)
- Entropy: 20 pts (near 50%)
- Threshold crossing: 0 pts (didn't cross 25/50/75)
- Volume: 10 pts ($5M)
- Sustained trend: 10 pts (same direction, 7d ≥ 5%)

Total: 80 points ✓ TRENDING + HOT
Reason: "+6.0% in 24h"
```

### Medium Score (25-40 points)

```
Market: "Will Y reach $100?"
Probability: 35%
Changes: +0.5% (1h), +4% (24h), +3% (7d)
Volume: $200K

Score breakdown:
- Momentum: 10 pts (0.5×3 + 4 = 5.5, ×2 = 11)
- Entropy: 18 pts (35% has good entropy)
- Threshold crossing: 0 pts
- Volume: 5 pts ($200K)
- Sustained trend: 0 pts (7d < 5%)

Total: 33 points ✓ TRENDING
Reason: "+4.0% in 24h"
```

### Low Score (< 15 points)

```
Market: "Will Z happen?"
Probability: 88%
Changes: +0.2% (1h), +0.5% (24h), -1% (7d)
Volume: $50K

Score breakdown:
- Momentum: 2 pts (0.2×3 + 0.5 = 1.1, ×2 = 2.2)
- Entropy: 11 pts (88% has low entropy)
- Threshold crossing: 0 pts
- Volume: 2 pts ($50K)
- Sustained trend: 0 pts

Subtotal: 15 pts
Penalty: ×0.5 (probability > 90% is close)
Total: ~13 points ✗ NOT TRENDING
```

## Tuning Parameters

Key thresholds that can be adjusted:

| Parameter | Current Value | Effect |
|-----------|---------------|--------|
| `isTrending` threshold | 15 | Lower = more markets shown |
| Momentum multiplier | 2 | Higher = momentum matters more |
| 1h weight | 3× | Higher = recent changes matter more |
| Entropy max bonus | 20 | Higher = uncertainty matters more |
| Threshold crossing bonus | 20 | Higher = crossing 25/50/75 matters more |
| Extreme penalty | 0.5× | Higher penalty = stricter on 90%+ markets |
| Volume thresholds | 10K/100K/1M | Adjust based on market activity |

## Data Sources

- **Price changes**: Calculated from D1 database snapshots (1h, 24h, 7d)
- **Volume**: From Polymarket API
- **Probability**: Current `outcomePrices[0] × 100`
