// Cloudflare Worker for fetching and processing Polymarket data
// Runs on a cron schedule, stores cache in D1, outputs to R2

import { GoogleGenAI, Type } from "@google/genai";

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  GOOGLE_API_KEY: string;
  POLYMARKET_API_URL: string;
  GEMINI_MODEL: string;
}

// Types
interface PolymarketMarket {
  id: string;
  question: string;
  endDateIso: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  volume: string | number;
  liquidity?: string | number;
  outcomePrices: string[] | string;
  outcomes: string[] | string;
  negRiskMarketID?: string;
  events?: Array<{ title?: string; slug?: string }>;
  slug?: string;
  description?: string;
}

interface ProcessedMarket extends PolymarketMarket {
  mostLikelyOutcome: string;
  currentProbability: number;
  displayProbability: number;
  statement: string;
  category: string;
  eventSlug?: string;
  priceChanges: PriceChanges;
  trendingScore: TrendingScore;
}

interface PriceChanges {
  hour1: number | null;
  hours24: number | null;
  days7: number | null;
}

interface TrendingScore {
  score: number;
  isTrending: boolean;
  reasons: string[];
}

interface MarketStatement {
  statement: string;
  category: string;
}

interface RedundancyResult {
  redundant_market_ids: string[];
  reasoning: string[];
}

interface MinimalMarket {
  id: string;
  outcomePrices: string[] | string;
}

interface HistoricalSnapshot {
  timestamp: string;
  markets: Map<string, MinimalMarket>;
}

interface OutputData {
  lastUpdated: string;
  marketCount: number;
  markets: ProcessedMarket[];
}

// Constants
const API_PAGE_LIMIT = 100;
const MAX_PAGES = 5;

// Helper: Parse JSON string arrays
function parseJsonArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Helper: Get most likely outcome from market
function getMostLikelyOutcome(market: PolymarketMarket): { outcome: string | null; probability: number | null } {
  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices);

  if (outcomes.length === 0 || prices.length === 0 || outcomes.length !== prices.length) {
    return { outcome: null, probability: null };
  }

  let maxProb = 0;
  let maxOutcome: string | null = null;

  for (let i = 0; i < outcomes.length; i++) {
    const prob = parseFloat(prices[i]) * 100;
    if (prob > maxProb) {
      maxProb = prob;
      maxOutcome = outcomes[i];
    }
  }

  return { outcome: maxOutcome, probability: maxProb };
}

// Fetch all markets from Polymarket API
async function fetchAllMarkets(apiUrl: string): Promise<PolymarketMarket[]> {
  console.log("Fetching markets from Polymarket API...");
  const allMarkets: PolymarketMarket[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * API_PAGE_LIMIT;
    const params = new URLSearchParams({
      limit: API_PAGE_LIMIT.toString(),
      offset: offset.toString(),
      active: "true",
      closed: "false",
      archived: "false",
    });

    try {
      const response = await fetch(`${apiUrl}?${params}`);
      if (!response.ok) {
        console.error(`API error at offset ${offset}: ${response.status}`);
        break;
      }

      const data = (await response.json()) as PolymarketMarket[];
      allMarkets.push(...data);
      console.log(`Fetched page ${page + 1}: ${data.length} markets (total: ${allMarkets.length})`);

      if (data.length < API_PAGE_LIMIT) break;
    } catch (error) {
      console.error(`Error fetching page ${page + 1}:`, error);
      break;
    }
  }

  return allMarkets;
}

// Load historical snapshots from D1
async function loadHistoricalSnapshots(db: D1Database): Promise<Record<string, HistoricalSnapshot | null>> {
  const snapshots: Record<string, HistoricalSnapshot | null> = {
    hour1: null,
    hours24: null,
    days7: null,
  };

  const now = Date.now();
  const minAges: Record<string, number> = {
    hour1: 60 * 60 * 1000,
    hours24: 24 * 60 * 60 * 1000,
    days7: 7 * 24 * 60 * 60 * 1000,
  };

  try {
    const result = await db
      .prepare("SELECT timestamp, markets_json FROM snapshots ORDER BY timestamp DESC")
      .all<{ timestamp: string; markets_json: string }>();

    for (const row of result.results) {
      const snapshotTime = parseTimestamp(row.timestamp);
      if (!snapshotTime) continue;

      const age = now - snapshotTime.getTime();

      for (const [period, minAge] of Object.entries(minAges)) {
        if (snapshots[period] === null && age >= minAge) {
          const marketsList = JSON.parse(row.markets_json) as MinimalMarket[];
          snapshots[period] = {
            timestamp: row.timestamp,
            markets: new Map(marketsList.map((m) => [m.id, m])),
          };
        }
      }

      if (Object.values(snapshots).every((s) => s !== null)) break;
    }
  } catch (error) {
    console.error("Error loading snapshots:", error);
  }

  const loaded = Object.entries(snapshots)
    .filter(([, v]) => v !== null)
    .map(([k]) => k);
  if (loaded.length > 0) {
    console.log(`Loaded snapshots: ${loaded.join(", ")}`);
  }

  return snapshots;
}

function parseTimestamp(ts: string): Date | null {
  // Format: YYYY-MM-DD_HH-MM
  const match = ts.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]));
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}`;
}

// Save historical snapshot to D1 (only store minimal price data to avoid size limits)
async function saveHistoricalSnapshot(db: D1Database, markets: PolymarketMarket[]): Promise<void> {
  const timestamp = formatTimestamp(new Date());

  // Only store id and outcomePrices to keep size small
  const minimalData = markets.map((m) => ({
    id: m.id,
    outcomePrices: m.outcomePrices,
  }));

  try {
    await db
      .prepare("INSERT OR REPLACE INTO snapshots (timestamp, markets_json) VALUES (?, ?)")
      .bind(timestamp, JSON.stringify(minimalData))
      .run();

    // Cleanup old snapshots (> 30 days)
    const cutoff = formatTimestamp(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await db.prepare("DELETE FROM snapshots WHERE timestamp < ?").bind(cutoff).run();
  } catch (error) {
    console.error("Error saving snapshot:", error);
  }
}

// Calculate price changes from historical data
function calculatePriceChanges(
  market: PolymarketMarket,
  snapshots: Record<string, HistoricalSnapshot | null>
): PriceChanges {
  const changes: PriceChanges = { hour1: null, hours24: null, days7: null };

  const prices = parseJsonArray(market.outcomePrices);
  if (prices.length === 0) return changes;

  const currentPrice = parseFloat(prices[0]) * 100;
  if (isNaN(currentPrice)) return changes;

  for (const period of ["hour1", "hours24", "days7"] as const) {
    const snapshot = snapshots[period];
    if (!snapshot) continue;

    const historicalMarket = snapshot.markets.get(market.id);
    if (!historicalMarket) continue;

    const histPrices = parseJsonArray(historicalMarket.outcomePrices);
    if (histPrices.length === 0) continue;

    const histPrice = parseFloat(histPrices[0]) * 100;
    if (!isNaN(histPrice)) {
      changes[period] = Math.round((currentPrice - histPrice) * 100) / 100;
    }
  }

  return changes;
}

// Calculate trending score based on momentum, entropy, and threshold crossings
function calculateTrendingScore(
  prob: number,
  priceChanges: PriceChanges,
  volume: number
): TrendingScore {
  const reasons: string[] = [];
  let score = 0;

  const change1h = priceChanges.hour1 ?? 0;
  const change24h = priceChanges.hours24 ?? 0;
  const change7d = priceChanges.days7 ?? 0;

  // 1. MOMENTUM COMPONENT (0-40 points)
  // Weighted: 1h = 3x, 24h = 1x (recent matters more)
  const momentumRaw = Math.abs(change1h) * 3 + Math.abs(change24h);
  const momentumScore = Math.min(40, momentumRaw * 2);
  score += momentumScore;

  if (Math.abs(change1h) >= 2) {
    reasons.push(`${change1h > 0 ? "+" : ""}${change1h.toFixed(1)}% in 1h`);
  } else if (Math.abs(change24h) >= 3) {
    reasons.push(`${change24h > 0 ? "+" : ""}${change24h.toFixed(1)}% in 24h`);
  }

  // 2. ENTROPY BONUS (0-20 points)
  // Markets near 50% have max uncertainty = most informative when they move
  const p = prob / 100;
  const entropy = p > 0 && p < 1 ? -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)) : 0;
  const entropyBonus = entropy * 20;
  score += entropyBonus;

  if (prob >= 40 && prob <= 60) {
    reasons.push("high uncertainty");
  }

  // 3. THRESHOLD CROSSING (0-20 points)
  // Crossing 25%, 50%, 75% is inherently newsworthy
  const prev24h = prob - change24h;
  const thresholds = [25, 50, 75];
  for (const threshold of thresholds) {
    if (
      (prev24h < threshold && prob >= threshold) ||
      (prev24h > threshold && prob <= threshold)
    ) {
      score += 20;
      reasons.push(`crossed ${threshold}%`);
      break;
    }
  }

  // 4. VOLUME WEIGHT (0-10 points)
  // High volume = confirmed move, real market participation
  if (volume >= 1_000_000) {
    score += 10;
  } else if (volume >= 100_000) {
    score += 5;
  } else if (volume >= 10_000) {
    score += 2;
  }

  // 5. SUSTAINED TREND BONUS (0-10 points)
  // Same direction across timeframes = stronger signal
  if (
    change1h !== 0 &&
    change24h !== 0 &&
    change7d !== 0 &&
    Math.sign(change1h) === Math.sign(change24h) &&
    Math.sign(change24h) === Math.sign(change7d) &&
    Math.abs(change7d) >= 5
  ) {
    score += 10;
    reasons.push("sustained trend");
  }

  // PENALTY: Markets at extremes need bigger moves to be interesting
  if (prob > 90 || prob < 10) {
    score *= 0.5;
  }

  return {
    score: Math.round(score),
    isTrending: score >= 15, // threshold for what counts as "trending"
    reasons,
  };
}

// Load redundancy cache from D1
async function loadRedundancyCache(db: D1Database): Promise<Map<string, string | null>> {
  const cache = new Map<string, string | null>();
  try {
    const result = await db
      .prepare("SELECT market_id, redundant_of FROM redundancy_cache")
      .all<{ market_id: string; redundant_of: string | null }>();
    for (const row of result.results) {
      cache.set(row.market_id, row.redundant_of);
    }
  } catch (error) {
    console.error("Error loading redundancy cache:", error);
  }
  return cache;
}

// Save redundancy decisions to D1
async function saveRedundancyCache(
  db: D1Database,
  decisions: Map<string, { redundantOf: string | null; reason: string }>
): Promise<void> {
  if (decisions.size === 0) return;

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO redundancy_cache (market_id, redundant_of, reason) VALUES (?, ?, ?)"
  );

  const batch = [...decisions.entries()].map(([id, { redundantOf, reason }]) =>
    stmt.bind(id, redundantOf, reason)
  );

  try {
    await db.batch(batch);
  } catch (error) {
    console.error("Error saving redundancy cache:", error);
  }
}

// Load statement cache from D1
async function loadStatementCache(
  db: D1Database
): Promise<Map<string, { statement: string; category: string; outcome: string }>> {
  const cache = new Map();
  try {
    const result = await db
      .prepare("SELECT market_id, statement, category, most_likely_outcome FROM statement_cache")
      .all<{ market_id: string; statement: string; category: string; most_likely_outcome: string }>();
    for (const row of result.results) {
      cache.set(row.market_id, {
        statement: row.statement,
        category: row.category,
        outcome: row.most_likely_outcome,
      });
    }
  } catch (error) {
    console.error("Error loading statement cache:", error);
  }
  return cache;
}

// Save statements to cache
async function saveStatementCache(
  db: D1Database,
  statements: Map<string, { statement: string; category: string; outcome: string }>
): Promise<void> {
  if (statements.size === 0) return;

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO statement_cache (market_id, statement, category, most_likely_outcome) VALUES (?, ?, ?, ?)"
  );

  const batch = [...statements.entries()].map(([id, { statement, category, outcome }]) =>
    stmt.bind(id, statement, category, outcome)
  );

  try {
    await db.batch(batch);
  } catch (error) {
    console.error("Error saving statement cache:", error);
  }
}

// Call Gemini LLM for redundancy check
async function checkRedundancyLLM(
  ai: GoogleGenAI,
  model: string,
  newMarkets: PolymarketMarket[],
  existingMarkets: PolymarketMarket[] = []
): Promise<Map<string, { redundantOf: string | null; reason: string }>> {
  const decisions = new Map<string, { redundantOf: string | null; reason: string }>();

  if (newMarkets.length === 0) return decisions;

  let prompt = `Identify REDUNDANT predictions that should be removed.

A prediction is REDUNDANT if another prediction logically implies it - if one is true, the other MUST also be true.

Examples of redundancy:
- "Gold above $4,000" makes "Gold above $3,200" redundant (higher implies lower)
- "Bitcoin hits $200k" makes "Bitcoin hits $150k" redundant
- "BTC reaches $100k by June" makes "BTC reaches $100k by December" redundant (earlier implies later)

NOT redundant (keep both):
- Different subjects: "Gold above $4000" vs "Silver above $50"
- Different directions: "Gold above $3000" vs "Gold below $4000"
- Unrelated: "Trump wins election" vs "Republicans win House"

Return IDs of predictions to REMOVE. When in doubt, keep both.

`;

  if (existingMarkets.length > 0) {
    prompt += "EXISTING PREDICTIONS (for reference):\n";
    for (const m of existingMarkets) {
      const { probability } = getMostLikelyOutcome(m);
      prompt += `- [${m.id}] ${m.question} (${probability?.toFixed(1)}%)\n`;
    }
    prompt += "\nNEW PREDICTIONS TO CHECK:\n";
  } else {
    prompt += "PREDICTIONS TO CHECK:\n";
  }

  for (const m of newMarkets) {
    const { probability } = getMostLikelyOutcome(m);
    prompt += `- [${m.id}] ${m.question} (${probability?.toFixed(1)}%)\n`;
  }

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            redundant_market_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
            reasoning: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["redundant_market_ids", "reasoning"],
        },
      },
    });

    const result = JSON.parse(response.text ?? "{}") as RedundancyResult;
    const redundantIds = new Set(result.redundant_market_ids);

    for (let i = 0; i < newMarkets.length; i++) {
      const m = newMarkets[i];
      if (redundantIds.has(m.id)) {
        decisions.set(m.id, {
          redundantOf: "redundant",
          reason: result.reasoning[i] || "redundant",
        });
      } else {
        decisions.set(m.id, { redundantOf: null, reason: "not redundant" });
      }
    }
  } catch (error) {
    console.error("Redundancy LLM error:", error);
    for (const m of newMarkets) {
      decisions.set(m.id, { redundantOf: null, reason: `error: ${error}` });
    }
  }

  return decisions;
}

// Call Gemini LLM to generate statements
async function generateStatements(
  ai: GoogleGenAI,
  model: string,
  markets: PolymarketMarket[]
): Promise<MarketStatement[]> {
  if (markets.length === 0) return [];

  const marketInputs = markets.map((m) => {
    const { outcome, probability } = getMostLikelyOutcome(m);
    const eventTitle = m.events?.[0]?.title;
    return { question: m.question, outcome, probability, eventTitle };
  });

  const prompt = `Convert each prediction market question into a concise declarative statement and classify its category.

Rules:
- Convert question to short affirmative statement: "[subject] will [verb]"
- CRITICAL: When an Event title is provided, incorporate key details from it into the statement
- Be concise: remove filler words, unnecessary dates, and verbose phrases
- Remove question marks, preserve capitalization (GDP, Q1, AI) and symbols

Categories:
- Politics, Sports, Crypto, Economics, Business, Entertainment, Geopolitics, Technology, Science, Pop Culture, Legal, Conspiracy

Examples:
- "Will Trump win the 2024 presidential election?" → "Trump will win 2024 election." Category: "Politics"
- "Will Bitcoin reach $150k by end of year?" → "Bitcoin will hit $150k." Category: "Crypto"

Markets to convert:
${marketInputs.map((m, i) => `${i + 1}. Question: ${m.question}${m.eventTitle && m.eventTitle !== m.question ? `\n   Event: ${m.eventTitle}` : ""}\n   Outcome: ${m.outcome} (${m.probability?.toFixed(1)}%)`).join("\n\n")}
`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              statement: { type: Type.STRING },
              category: { type: Type.STRING },
            },
            required: ["statement", "category"],
          },
        },
      },
    });

    const statements = JSON.parse(response.text ?? "[]") as MarketStatement[];

    // Pad with fallbacks if needed
    while (statements.length < markets.length) {
      const idx = statements.length;
      statements.push({
        statement: markets[idx].question.replace(/\?$/, "."),
        category: "Uncategorized",
      });
    }

    return statements;
  } catch (error) {
    console.error("Statement generation error:", error);
    return markets.map((m) => ({
      statement: m.question.replace(/\?$/, "."),
      category: "Uncategorized",
    }));
  }
}

// Deduplicate related markets (same negRiskMarketID)
function deduplicateRelatedMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
  const groups = new Map<string, PolymarketMarket[]>();
  const standalone: PolymarketMarket[] = [];

  for (const market of markets) {
    if (market.negRiskMarketID) {
      const group = groups.get(market.negRiskMarketID) || [];
      group.push(market);
      groups.set(market.negRiskMarketID, group);
    } else {
      standalone.push(market);
    }
  }

  const deduplicated: PolymarketMarket[] = [];

  for (const groupMarkets of groups.values()) {
    if (groupMarkets.length === 1) {
      deduplicated.push(groupMarkets[0]);
    } else {
      // Keep highest probability "Yes" market, or highest volume
      const withOutcomes = groupMarkets.map((m) => ({
        market: m,
        ...getMostLikelyOutcome(m),
      }));

      const yesMarkets = withOutcomes.filter((m) => m.outcome === "Yes");
      if (yesMarkets.length > 0) {
        const best = yesMarkets.reduce((a, b) => ((a.probability || 0) > (b.probability || 0) ? a : b));
        deduplicated.push(best.market);
      } else {
        const best = groupMarkets.reduce((a, b) =>
          parseFloat(String(a.volume || 0)) > parseFloat(String(b.volume || 0)) ? a : b
        );
        deduplicated.push(best);
      }
    }
  }

  return [...deduplicated, ...standalone];
}

// Main filter and process function
async function filterAndProcessMarkets(
  env: Env,
  markets: PolymarketMarket[],
  snapshots: Record<string, HistoricalSnapshot | null>
): Promise<ProcessedMarket[]> {
  const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
  const now = Date.now();
  const filtered: Array<PolymarketMarket & { mostLikelyOutcome: string; currentProbability: number }> = [];

  // Basic filtering - looser criteria, let trending logic do the heavy lifting
  for (const market of markets) {
    if (!market.endDateIso || !market.active || market.closed) continue;

    try {
      const endDate = new Date(market.endDateIso);
      const daysUntilEnd = (endDate.getTime() - now) / (24 * 60 * 60 * 1000);
      if (daysUntilEnd <= 0 || daysUntilEnd > 90) continue;

      const { outcome, probability } = getMostLikelyOutcome(market);
      if (!outcome || probability === null) continue;

      // Minimum volume filter - need real market activity
      const volume = parseFloat(String(market.volume || 0));
      if (volume < 10_000) continue;

      // Exclude extreme certainty markets (essentially decided)
      if (probability > 95 || probability < 5) continue;

      filtered.push({
        ...market,
        mostLikelyOutcome: outcome,
        currentProbability: probability,
      });
    } catch {
      continue;
    }
  }

  console.log(`Filtered: ${markets.length} → ${filtered.length} markets`);

  // Deduplicate related markets
  const afterRelatedDedup = deduplicateRelatedMarkets(filtered) as typeof filtered;
  console.log(`After related dedup: ${afterRelatedDedup.length} markets`);

  // Semantic deduplication with LLM
  const redundancyCache = await loadRedundancyCache(env.DB);
  const cachedMarkets: typeof filtered = [];
  const newMarkets: typeof filtered = [];

  for (const m of afterRelatedDedup) {
    if (redundancyCache.has(m.id)) {
      if (redundancyCache.get(m.id) === null) {
        cachedMarkets.push(m);
      }
      // Skip redundant ones (redundant_of is not null)
    } else {
      newMarkets.push(m);
    }
  }

  let finalMarkets = [...cachedMarkets];

  if (newMarkets.length > 0) {
    console.log(`Checking ${newMarkets.length} new markets for redundancy...`);
    const decisions = await checkRedundancyLLM(ai, env.GEMINI_MODEL, newMarkets, cachedMarkets);
    await saveRedundancyCache(env.DB, decisions);

    for (const m of newMarkets) {
      const decision = decisions.get(m.id);
      if (!decision || decision.redundantOf === null) {
        finalMarkets.push(m);
      }
    }
  }

  console.log(`After semantic dedup: ${finalMarkets.length} markets`);

  // Load statement cache and generate statements for new markets
  const statementCache = await loadStatementCache(env.DB);
  const marketsNeedingStatements: typeof finalMarkets = [];
  const marketIndices: number[] = [];

  const processed: ProcessedMarket[] = [];

  for (let i = 0; i < finalMarkets.length; i++) {
    const market = finalMarkets[i];
    const cached = statementCache.get(market.id);

    const priceChanges = calculatePriceChanges(market, snapshots);
    const volume = parseFloat(String(market.volume || 0));
    const trendingScore = calculateTrendingScore(market.currentProbability, priceChanges, volume);

    if (cached && cached.outcome === market.mostLikelyOutcome) {
      processed.push({
        ...market,
        displayProbability: Math.round(market.currentProbability),
        statement: cached.statement,
        category: cached.category,
        eventSlug: market.events?.[0]?.slug,
        priceChanges,
        trendingScore,
      });
    } else {
      marketsNeedingStatements.push(market);
      marketIndices.push(i);
      // Placeholder - will be replaced
      processed.push({
        ...market,
        displayProbability: Math.round(market.currentProbability),
        statement: "",
        category: "",
        eventSlug: market.events?.[0]?.slug,
        priceChanges,
        trendingScore,
      });
    }
  }

  if (marketsNeedingStatements.length > 0) {
    console.log(`Generating ${marketsNeedingStatements.length} statements via LLM...`);
    const statements = await generateStatements(ai, env.GEMINI_MODEL, marketsNeedingStatements);

    const newStatements = new Map<string, { statement: string; category: string; outcome: string }>();

    for (let i = 0; i < statements.length; i++) {
      const market = marketsNeedingStatements[i];
      const stmt = statements[i];
      const idx = marketIndices[i];

      processed[idx].statement = stmt.statement;
      processed[idx].category = stmt.category;

      newStatements.set(market.id, {
        statement: stmt.statement,
        category: stmt.category,
        outcome: market.mostLikelyOutcome,
      });
    }

    await saveStatementCache(env.DB, newStatements);
  }

  // Filter to only trending markets and sort by score (highest first)
  const trending = processed.filter((m) => m.trendingScore.isTrending);
  trending.sort((a, b) => b.trendingScore.score - a.trendingScore.score);

  console.log(`Trending: ${trending.length} of ${processed.length} markets`);

  // If very few trending, include top movers by absolute change as fallback
  if (trending.length < 3) {
    const nonTrending = processed
      .filter((m) => !m.trendingScore.isTrending)
      .sort((a, b) => b.trendingScore.score - a.trendingScore.score)
      .slice(0, 5 - trending.length);
    console.log(`Adding ${nonTrending.length} top movers as fallback`);
    return [...trending, ...nonTrending];
  }

  return trending;
}

// Upload to R2
async function uploadToR2(r2: R2Bucket, data: OutputData): Promise<boolean> {
  try {
    await r2.put("markets.json", JSON.stringify(data), {
      httpMetadata: { contentType: "application/json" },
    });
    console.log("Uploaded to R2: markets.json");
    return true;
  } catch (error) {
    console.error("R2 upload error:", error);
    return false;
  }
}

// Main handler
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron triggered at ${new Date(event.scheduledTime).toISOString()}`);

    try {
      // Fetch all markets
      const allMarkets = await fetchAllMarkets(env.POLYMARKET_API_URL);
      console.log(`Fetched ${allMarkets.length} markets`);

      if (allMarkets.length === 0) {
        console.error("No markets fetched, aborting");
        return;
      }

      // Save snapshot for price history
      await saveHistoricalSnapshot(env.DB, allMarkets);

      // Load historical snapshots
      const snapshots = await loadHistoricalSnapshots(env.DB);

      // Filter and process
      const processedMarkets = await filterAndProcessMarkets(env, allMarkets, snapshots);

      // Prepare output
      const output: OutputData = {
        lastUpdated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        marketCount: processedMarkets.length,
        markets: processedMarkets,
      };

      // Upload to R2
      await uploadToR2(env.R2, output);

      console.log(`Done! Saved ${processedMarkets.length} markets`);
    } catch (error) {
      console.error("Worker error:", error);
      throw error;
    }
  },

  // HTTP handler for manual triggers / testing
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      // Manual trigger
      ctx.waitUntil(this.scheduled({ scheduledTime: Date.now(), cron: "manual" } as ScheduledEvent, env, ctx));
      return new Response("Job triggered", { status: 202 });
    }

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};
