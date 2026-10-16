#!/usr/bin/env node
// Regenerates src/models.gen.ts — per-model cost (USD/Mtok) and context/output
// limit metadata for OpenCode's spend display and compaction timing — from the
// models.dev dataset.
//
//   node scripts/gen-models.mjs [path/to/models.dev-api.json]
//
// With no argument the script fetches https://models.dev/api.json itself.
// Output is committed (src/models.gen.ts); regeneration only when the catalog
// or upstream data changes.
//
// Source-selection policy (deliberate, do not "simplify"):
//   * Prices are the **upstream vendor list prices** (Anthropic/OpenAI/Google/…),
//     NOT Factory charges — Factory bills subscription quota, not USD/token.
//     OpenCode's cost display estimates what these tokens would cost at list.
//   * Limits are the **upstream vendor context/output windows** — what the model
//     actually accepts. Factory proxies to the vendor limit; OpenCode uses this
//     for compaction timing, so a wrong (too small) value causes premature
//     compaction and a wrong (too large) value causes context-overflow 400s.
//   * Only canonical vendor records are accepted (never resellers, whose values
//     diverge wildly). An unresolvable model aborts generation instead of
//     silently picking a bad source — fix the ALIAS/PREF tables by hand.
//   * Factory `-fast` models are fast-routing aliases of the base model: same
//     price and limits, so they inherit the base entry.
//   * models.dev `cost.tiers[]` maps to schema `cost[]` entries with
//     `tier: {type: "context", size}`; `cost.context_over_200k` is redundant, dropped.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROUTES } from "../src/catalog.ts";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "models.gen.ts");

/** models.dev provider preference per model family (first hit wins). */
const PREF = [
  [/^claude/, ["anthropic"]],
  [/^gpt/, ["openai"]],
  [/^gemini/, ["google"]],
  [/^grok/, ["xai"]],
  [/^glm/, ["zhipuai"]],
  [/^kimi/, ["moonshotai"]],
  [/^qwen/, ["alibaba"]],
  [/^deepseek/, ["deepseek"]],
  [/^minimax/, ["minimax"]],
  [/^mistral/, ["mistral"]],
  [/^nemotron/, ["nvidia"]],
];

/** Factory model id -> models.dev model id, when they differ. */
const ALIAS = {
  // anthropic spells it with a dash
  "claude-fable-5.1": "claude-fable-5-1",
  // nvidia prefixes with the org
  "nemotron-3-ultra": "nvidia/nemotron-3-ultra-550b-a55b",
  // mistral uses date-based ids; medium-2604 is medium 3.5 (price-confirmed
  // against resellers listing "mistral-medium-3.5": 1.5/7.5/0.15)
  "mistral-medium-3.5": "mistral-medium-2604",
  // dated snapshots / point releases of the canonical flash model; reseller
  // consensus for both equals deepseek's own deepseek-v4-flash values
  "deepseek-v4.1-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
};

/** Factory model id -> forced models.dev provider, when it has no canonical vendor. */
const PROVIDER_OVERRIDE = {
  // Inkling has no first-party listing; neon carries representative list values
  inkling: "neon",
};

async function loadDataset() {
  const arg = process.argv[2];
  if (arg) {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(arg, "utf8"));
  }
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) throw new Error(`fetch models.dev: ${res.status}`);
  return res.json();
}

function pickProvider(factoryID) {
  const forced = PROVIDER_OVERRIDE[factoryID];
  if (forced) return [forced];
  for (const [re, providers] of PREF) if (re.test(factoryID)) return providers;
  return [];
}

function findRecord(dataset, factoryID) {
  const fast = factoryID.endsWith("-fast");
  const base = fast ? factoryID.slice(0, -"-fast".length) : factoryID;
  const targetID = ALIAS[base] ?? base;
  const providers = pickProvider(base);
  for (const pid of providers) {
    const models = dataset[pid]?.models ?? {};
    // case-insensitive id match (models.dev has e.g. minimax:MiniMax-M3)
    const hit = Object.keys(models).find((k) => k.toLowerCase() === targetID.toLowerCase());
    if (hit) return { record: models[hit], source: `${pid}:${hit}`, base };
  }
  return null;
}

function toCostRows(cost) {
  const row = (tier, c) => ({
    ...(tier ? { tier } : {}),
    input: c.input,
    output: c.output,
    cache: { read: c.cache_read ?? 0, write: c.cache_write ?? 0 },
  });
  const rows = [row(undefined, cost)];
  for (const t of cost.tiers ?? []) rows.push(row(t.tier, t));
  return rows;
}

function toLimitRow(limit) {
  if (!limit || typeof limit.context !== "number" || typeof limit.output !== "number") return null;
  const row = { context: limit.context, output: limit.output };
  if (typeof limit.input === "number") row.input = limit.input;
  return row;
}

const dataset = await loadDataset();
const ids = ROUTES.flatMap((r) => r.models).map((m) => m.id);

const costLines = [];
const limitLines = [];
const problems = [];
const seen = new Map(); // models.dev source -> factory ids sharing it

for (const id of ids) {
  const found = findRecord(dataset, id);
  if (!found) {
    problems.push(`  ${id}: no canonical-vendor record (providers tried: ${pickProvider(id).join(", ") || "none"})`);
    continue;
  }
  const { record, source } = found;

  const notes = [];
  if (ALIAS[id]) notes.push(`alias -> ${ALIAS[id]}`);
  if (id.endsWith("-fast")) notes.push("fast variant -> base entry");
  if (PROVIDER_OVERRIDE[id]) notes.push("reseller source (no first-party listing)");
  const comment = notes.length ? `  // ${id} <- ${source} (${notes.join("; ")})\n` : "";

  if (!("cost" in record)) {
    problems.push(`  ${id}: ${source} has no cost`);
  } else {
    const rows = toCostRows(record.cost);
    costLines.push(`${comment}  ${JSON.stringify(id)}: ${JSON.stringify(rows)},`);
  }

  const limit = toLimitRow(record.limit);
  if (!limit) {
    problems.push(`  ${id}: ${source} has no usable limit`);
  } else {
    limitLines.push(`${comment}  ${JSON.stringify(id)}: ${JSON.stringify(limit)},`);
  }

  seen.set(source, [...(seen.get(source) ?? []), id]);
}

if (problems.length) {
  console.error("gen-models: unresolved models — extend ALIAS/PREF/PROVIDER_OVERRIDE or inspect source:\n" + problems.join("\n"));
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const body = `// GENERATED by scripts/gen-models.mjs — do not edit by hand.
// Regenerate: node scripts/gen-models.mjs [models.dev api.json]
//
// Upstream vendor list values from models.dev, fetched ${today}.
//
// COSTS — USD per million tokens, used by OpenCode's spend display. These are the
// underlying vendors' prices; Factory bills subscription quota instead, so real
// spend against a Factory plan is not these numbers (see
// docs/factory-droid-behavior.md §11).
//
// LIMITS — upstream context/output windows. Factory proxies to the vendor limit;
// OpenCode uses these for compaction timing (too small => premature compaction,
// too large => context-overflow 400s).
//
// Factory "-fast" models inherit the base entry. Direct source notes are inlined
// below where the mapping is not obvious (aliases, reseller-only models).

import type { Model } from "@opencode/plugin";

/** Structural mirror of Model.Cost / Model.Info["limit"] without the Money brands. */
type CostRow = {
  tier?: { type: "context"; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
};
type LimitRow = { context: number; input?: number; output: number };

const RAW_COSTS: Record<string, CostRow[]> = {
${costLines.join("\n")}
};

const RAW_LIMITS: Record<string, LimitRow> = {
${limitLines.join("\n")}
};

// Brands (Money.USDPerMillionTokens) are compile-time only; the raw tables are
// checked structurally above and validated by the catalog schema at registration.
export const COSTS = RAW_COSTS as unknown as Record<string, Model.Cost[]>;
export const LIMITS = RAW_LIMITS as unknown as Record<string, Model.Info["limit"]>;
`;

writeFileSync(OUT, body);
console.log(
  `gen-models: wrote ${OUT} (${ids.length} models, ${costLines.length} costs, ${limitLines.length} limits, ${seen.size} distinct sources)`,
);
