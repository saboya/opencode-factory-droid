import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadMultipliers,
  multiplierName,
  parseMultipliers,
  type MultiplierTable,
} from "../src/multipliers.ts";

const catalog = `# Available Models
| Model | Model ID | Multiplier | Reasoning |
| --- | --- | --- | --- |
| Claude Opus 5.5 | \`claude-opus-5-5\` | 1.6× | \`high\` |
| GPT-6.1 Sol | \`gpt-6.1-sol\` | 0.8× | \`high\` |
| GPT-5.6 Sol<sup>†</sup> | \`gpt-5.6-sol\` | 1.6× | \`high\` |
| Mistral Large 4<sup>†</sup> | \`mistral-large-4\` | 0.272× | \`high\` |
| Example Free | \`example-free\` | 0x | \`off\` |
| Not a multiplier | \`invalid-price\` | $2.50 | \`high\` |
| Invalid | \`invalid-number\` | Infinity× | \`high\` |

<Note>
<sup>†</sup> Promotional pricing. GPT-5.6 Sol bills at 1.6× through November 22, 2026, then returns to 2×.

<sup>†</sup> Launch pricing. Mistral Large 4 bills at 0.272× through October 20, 2026, then returns to 0.544×.
</Note>`;

const online: typeof fetch = async () => new Response(catalog);
const offline: typeof fetch = async () => { throw new Error("offline"); };

test("parses Factory model rows and promotional footnotes without confusing USD prices for multipliers", () => {
  const table = parseMultipliers(catalog);
  assert.deepEqual(Object.keys(table).sort(), [
    "claude-opus-5-5", "example-free", "gpt-5.6-sol", "gpt-6.1-sol", "mistral-large-4",
  ]);
  assert.equal(table["gpt-5.6-sol"].expiresAt, Date.parse("2026-11-22T00:00:00Z"));
  assert.equal(table["mistral-large-4"].regularMultiplier, 0.544);
  assert.equal(multiplierName("Opus", "claude-opus-5-5", table), "Opus (1.6×)");
  assert.equal(multiplierName("Free", "example-free", table), "Free (0×)");
  assert.equal(multiplierName("Unknown", "unknown-model", table), "Unknown");
});

test("refreshes cached rates from the public catalog and persists promotion expiry", async () => {
  let saved: MultiplierTable | undefined;
  const table = await loadMultipliers({
    fetch: online,
    store: {
      read: async () => ({ "gpt-6.1-sol": { multiplier: 2 } }),
      write: async (value) => { saved = value; },
    },
  });
  assert.equal(table["gpt-6.1-sol"].multiplier, 0.8);
  assert.equal(saved?.["mistral-large-4"].expiresAt, Date.parse("2026-10-20T00:00:00Z"));
  assert.equal(table["gemini-4-argon"].multiplier, 0.8); // SDK-only fallback
});

test("cached discounts expire even when the public catalog is unreachable", async () => {
  const cached = await loadMultipliers({ fetch: online });
  const table = await loadMultipliers({
    fetch: offline,
    store: { read: async () => cached, write: async () => {} },
  });
  const cutoff = Date.parse("2026-10-20T00:00:00Z");
  assert.equal(multiplierName("Mistral", "mistral-large-4", table, cutoff - 1), "Mistral (0.272×)");
  assert.equal(multiplierName("Mistral", "mistral-large-4", table, cutoff), "Mistral (0.544×)");
});

test("changed prices replace old promotions; partial catalogs preserve known cutoffs", async () => {
  const changed = await loadMultipliers({
    fetch: async () => new Response(catalog.replace(
      "| `gpt-5.6-sol` | 1.6×", "| `gpt-5.6-sol` | 1.4×",
    )),
  });
  assert.equal(multiplierName("GPT", "gpt-5.6-sol", changed, Date.parse("2026-12-01")), "GPT (1.4×)");
  const partial = await loadMultipliers({ fetch: async () => new Response(catalog.split("<Note>")[0]) });
  assert.equal(partial["gpt-5.6-sol"].expiresAt, Date.parse("2026-11-22T00:00:00Z"));
});

test("broken responses and invalid caches fall back without preventing model registration", async () => {
  for (const response of [new Response("unavailable", { status: 503 }), new Response("<html>No catalog</html>")]) {
    const table = await loadMultipliers({
      fetch: async () => response,
      store: {
        read: async () => ({
          "claude-opus-5-5": { multiplier: "1.6" },
          "gpt-6.1-sol": { multiplier: -1 },
          "mistral-large-4": { multiplier: 0.1, expiresAt: 1 },
        }),
        write: async () => { throw new Error("storage unavailable"); },
      },
    });
    assert.equal(multiplierName("Opus", "claude-opus-5-5", table), "Opus (1.6×)");
    assert.equal(multiplierName("GPT", "gpt-6.1-sol", table), "GPT (0.8×)");
  }
  const table = await loadMultipliers({
    fetch: online,
    store: {
      read: async () => { throw new Error("storage unavailable"); },
      write: async () => { throw new Error("storage unavailable"); },
    },
  });
  assert.equal(table["gpt-5.6-sol"].multiplier, 1.6);
});
