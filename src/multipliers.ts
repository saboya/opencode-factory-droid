/**
 * Factory credit multipliers, separate from the USD costs in models.gen.ts.
 *
 * Droid's SDK exposes tokenMultiplier via droid.list_models, but that requires
 * spawning the official CLI. Its public model catalog publishes the same values
 * as Markdown, so use that lightweight source at setup instead.
 */
export const MULTIPLIER_SOURCE = "https://docs.factory.com/models.md";
export const MULTIPLIER_CACHE_KEY = "factory/model-multipliers";

interface Multiplier {
  multiplier: number;
  /** End of a temporary rate, followed by regularMultiplier. */
  expiresAt?: number;
  regularMultiplier?: number;
}

export type MultiplierTable = Record<string, Multiplier>;

export interface MultiplierStore {
  read(): Promise<unknown>;
  write(value: MultiplierTable): Promise<void>;
}

// Verified against Factory's SDK 0.9.1 / CLI 0.243.0 on 2026-10-17.
// Promotion cutoffs come from Factory's public web-client model registry.
// Do not infer these from vendor USD prices or inherit a base rate for -fast.
const FALLBACK: MultiplierTable = Object.fromEntries(
  Object.entries({
    "claude-fable-5.1": 4,
    "claude-fable-5": 4,
    "claude-opus-5-5": 1.6,
    "claude-opus-5-5-fast": 3.2,
    "claude-opus-5": 2,
    "claude-opus-5-fast": 4,
    "claude-opus-4-8": 2,
    "claude-opus-4-8-fast": 4,
    "claude-opus-4-7": 2,
    "claude-opus-4-6": 2,
    "claude-sonnet-5-5": 0.8,
    "claude-sonnet-5": 0.8,
    "claude-sonnet-4-6": 1.2,
    "claude-haiku-5-5": 0.04,
    "gpt-6.1-sol": 0.8,
    "gpt-6-astra": 4,
    "gpt-6-sol": 0.8,
    "gpt-6-luna": 0.04,
    "gpt-5.6-terra": 0.8,
    "gpt-5.6-luna": 0.08,
    "gpt-5.5": 2,
    "gpt-5.3-codex": 0.7,
    "gpt-5.2": 0.7,
    "gemini-3.1-pro-preview": 0.8,
    "grok-4.7": 0.8,
    "grok-4.6": 0.8,
    inkling: 0.4,
    "mistral-medium-3.5": 0.6,
    "glm-5.3-flash": 0.06,
    "glm-5.3": 0.56,
    "glm-5.2": 0.56,
    "glm-5.2-fast": 0.84,
    "kimi-k3": 1.2,
    "qwen3.8-max": 0.8,
    "nemotron-3-ultra": 0.24,
    "minimax-m3": 0.12,
    "deepseek-v4.1-flash": 0.12,
    "deepseek-v4-flash-0731": 0.176,
    "deepseek-v4-pro": 0.528,
  }).map(([id, multiplier]) => [id, { multiplier }]),
);

Object.assign(FALLBACK, {
  "gpt-5.6-sol": {
    multiplier: 1.6, regularMultiplier: 2, expiresAt: Date.parse("2026-11-22T00:00:00Z"),
  },
  "gemini-3.8-flash": {
    multiplier: 0.3, regularMultiplier: 0.6, expiresAt: Date.parse("2027-01-01T08:00:00Z"),
  },
  "gemini-4-argon": {
    multiplier: 0.8, regularMultiplier: 1.6, expiresAt: Date.parse("2026-12-01T08:00:00Z"),
  },
  "mistral-large-4": {
    multiplier: 0.272, regularMultiplier: 0.544, expiresAt: Date.parse("2026-10-20T00:00:00Z"),
  },
} satisfies MultiplierTable);

const RATE = /^(\d+(?:\.\d+)?)\s*[×x]$/;
const validRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Parse only model-ID/rate columns, not numbers in prose or reasoning settings. */
export function parseMultipliers(markdown: string): MultiplierTable {
  const table: MultiplierTable = {};
  const names = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const columns = line.trim().split("|").map((column) => column.trim());
    const id = /^`([a-z0-9][a-z0-9._-]*)`$/.exec(columns[2] ?? "")?.[1];
    const rate = RATE.exec(columns[3] ?? "");
    if (!id || !rate || !validRate(Number(rate[1]))) continue;
    table[id] = { multiplier: Number(rate[1]) };
    const name = columns[1].replace(/<sup>.*?<\/sup>/g, "").replace(/\\?[*†‡]/g, "").trim();
    names.set(name, id);
  }

  // Keep cached promotions from outliving their published end dates. Factory's
  // client has precise cutoffs for known promotions; use those when the terms
  // match, otherwise use the published cutoff date (UTC).
  const promotion = /([^\n<>]+?) bills at (\d+(?:\.\d+)?)[×x] through ([A-Za-z]+ \d{1,2}, \d{4}), then returns to (\d+(?:\.\d+)?)[×x]/g;
  for (const match of markdown.matchAll(promotion)) {
    const name = match[1].replace(/^.*?(?:Promotional pricing\.|Launch pricing\.)\s*/, "").trim();
    const id = names.get(name);
    if (!id || table[id].multiplier !== Number(match[2])) continue;
    const publishedCutoff = Date.parse(`${match[3]} UTC`);
    const regularMultiplier = Number(match[4]);
    if (!Number.isFinite(publishedCutoff) || !validRate(regularMultiplier)) continue;
    const known = FALLBACK[id];
    const samePromotion = known?.multiplier === table[id].multiplier
      && known.regularMultiplier === regularMultiplier
      && known.expiresAt !== undefined
      && Math.floor(known.expiresAt / 86_400_000) === Math.floor(publishedCutoff / 86_400_000);
    table[id] = {
      ...table[id], regularMultiplier,
      expiresAt: samePromotion ? known.expiresAt : publishedCutoff,
    };
  }
  return table;
}

function cachedMultipliers(value: unknown): MultiplierTable {
  const table: MultiplierTable = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return table;
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<Multiplier>;
    if (!validRate(row.multiplier)) continue;
    if (row.expiresAt !== undefined && (!Number.isFinite(row.expiresAt) || !validRate(row.regularMultiplier))) continue;
    table[id] = {
      multiplier: row.multiplier,
      ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt, regularMultiplier: row.regularMultiplier } : {}),
    };
  }
  return table;
}

/** Fresh public catalog → last-known cache → verified bundled snapshot. */
export async function loadMultipliers(options: {
  store?: MultiplierStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<MultiplierTable> {
  let cached: MultiplierTable = {};
  try {
    cached = cachedMultipliers(await options.store?.read());
  } catch { /* cache is best effort */ }
  try {
    const response = await (options.fetch ?? fetch)(MULTIPLIER_SOURCE, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!response.ok) throw new Error(`Factory model catalog: HTTP ${response.status}`);
    const fresh = parseMultipliers(await response.text());
    if (Object.keys(fresh).length === 0) throw new Error("Factory model catalog has no multiplier rows");
    // Preserve promotion cutoffs for rows if only the table (not its footnotes)
    // was returned. A changed rate replaces the previous promotion entirely.
    const previous = { ...FALLBACK, ...cached };
    for (const [id, row] of Object.entries(fresh)) {
      if (row.expiresAt === undefined && row.multiplier === previous[id]?.multiplier) {
        fresh[id] = { ...previous[id], ...row };
      }
    }
    const merged = { ...previous, ...fresh };
    try { await options.store?.write(merged); } catch { /* cache is best effort */ }
    return merged;
  } catch {
    return { ...FALLBACK, ...cached };
  }
}

/** No rate for an unknown model: omit the label rather than guessing 1×. */
export function multiplierName(name: string, id: string, table: MultiplierTable, now = Date.now()): string {
  const row = table[id];
  if (!row) return name;
  const rate = row.expiresAt !== undefined && now >= row.expiresAt ? row.regularMultiplier : row.multiplier;
  return validRate(rate) ? `${name} (${rate}×)` : name;
}
