// Cloudflare Worker for fetching and processing Polymarket data
// Runs on a cron schedule, stores cache in D1, outputs to R2

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  GOOGLE_API_KEY: string;
  POLYMARKET_API_URL: string;
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
}

interface PriceChanges {
  hour1: number | null;
  hours24: number | null;
  days7: number | null;
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
const MODEL = "gemini-2.5-flash-lite";
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
  apiKey: string,
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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                redundant_market_ids: { type: "array", items: { type: "string" } },
                reasoning: { type: "array", items: { type: "string" } },
              },
              required: ["redundant_market_ids", "reasoning"],
            },
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!resultText) throw new Error("Empty response from Gemini");

    const result = JSON.parse(resultText) as RedundancyResult;
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
  apiKey: string,
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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: "application/json",
            responseSchema: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  statement: { type: "string" },
                  category: { type: "string" },
                },
                required: ["statement", "category"],
              },
            },
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!resultText) throw new Error("Empty response from Gemini");

    const statements = JSON.parse(resultText) as MarketStatement[];

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
  const now = Date.now();
  const filtered: Array<PolymarketMarket & { mostLikelyOutcome: string; currentProbability: number }> = [];

  // Basic filtering
  for (const market of markets) {
    if (!market.endDateIso || !market.active || market.closed) continue;

    try {
      const endDate = new Date(market.endDateIso);
      const daysUntilEnd = (endDate.getTime() - now) / (24 * 60 * 60 * 1000);
      if (daysUntilEnd <= 0 || daysUntilEnd > 90) continue;

      const { outcome, probability } = getMostLikelyOutcome(market);
      if (!outcome || probability === null) continue;
      if (outcome === "No") continue;
      if (probability < 55) continue;

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
    const decisions = await checkRedundancyLLM(env.GOOGLE_API_KEY, newMarkets, cachedMarkets);
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

    if (cached && cached.outcome === market.mostLikelyOutcome) {
      processed.push({
        ...market,
        displayProbability: Math.round(market.currentProbability),
        statement: cached.statement,
        category: cached.category,
        eventSlug: market.events?.[0]?.slug,
        priceChanges,
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
      });
    }
  }

  if (marketsNeedingStatements.length > 0) {
    console.log(`Generating ${marketsNeedingStatements.length} statements via LLM...`);
    const statements = await generateStatements(env.GOOGLE_API_KEY, marketsNeedingStatements);

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

  // Sort by volume (descending)
  processed.sort((a, b) => parseFloat(String(b.volume || 0)) - parseFloat(String(a.volume || 0)));

  return processed;
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
