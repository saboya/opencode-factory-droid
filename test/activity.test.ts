import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { registerActivity } from "../src/activity.ts";
import { PayloadManager } from "../src/payload.ts";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

test("activity is durable, deduplicated, session-scoped, bounded, and never a chat message", async () => {
  const store = new Map<string, unknown>();
  let list: (input: unknown) => Promise<unknown> = async () => {};
  const events: unknown[] = [];
  let disposed = 0;
  const ctx = {
    storage: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } },
    rpc: { register: async (_definition: unknown, handlers: { list: typeof list }) => {
      list = handlers.list;
      return { events: { emit: async (_kind: string, data: unknown) => { events.push(data); } }, dispose: async () => { disposed++; } };
    } },
    session: { synthetic: () => { throw new Error("must not write model-visible messages"); } },
  } as unknown as Context;
  const activity = await registerActivity(ctx);
  const notice = { key: "same", kind: "images" as const, message: "Optimized 2 images" };
  await Promise.all([activity.record("session-a", notice), activity.record("session-a", notice), activity.record("session-b", notice)]);
  assert.equal(events.length, 2);
  let result = await list({ sessionID: "session-a" }) as { entries: Array<Record<string, unknown>> };
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].message, notice.message);
  assert.equal(result.entries[0].key, undefined, "internal hashes are not sent to UI");
  const status = { bytes: 2_800_000, budget: 4_000_000, time: 123 };
  await activity.payload("session-a", status);
  assert.deepEqual((await list({ sessionID: "session-a" }) as { payload: unknown }).payload, status);
  assert.equal((await list({ sessionID: "session-a" }) as typeof result).entries.length, 1,
    "payload updates must not generate activity notices");
  assert.equal((await list({ sessionID: "session-b" }) as { payload?: unknown }).payload, undefined);
  await activity.dispose();
  const reloaded = await registerActivity(ctx);
  await reloaded.record("session-a", notice);
  assert.equal(events.length, 3, "deduplication survives reload");
  assert.deepEqual((await list({ sessionID: "session-a" }) as { payload: unknown }).payload, status,
    "payload status survives plugin reload");
  for (let i = 0; i < 205; i++) await reloaded.record("session-a", { ...notice, key: String(i) });
  result = await list({ sessionID: "session-a" }) as typeof result;
  assert.equal(result.entries.length, 200);
  assert.equal((await list({ sessionID: "session-b" }) as typeof result).entries.length, 1);
  await reloaded.dispose();
  assert.equal(disposed, 2);
});

test("activity persistence failures cannot fail a request", async () => {
  const activity = await registerActivity({
    storage: { get: async () => { throw new Error("disk failure"); } },
    rpc: { register: async () => ({ events: { emit: async () => {} }, dispose: async () => {} }) },
  } as unknown as Context);
  await activity.record("session", { key: "key", kind: "budget", message: "Over budget" });
  await activity.dispose();
});

test("payload notices report budget and summary without adding notice text to model requests", async (t) => {
  const notices: Array<{ kind: string; message: string }> = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ output: [
    { content: [{ type: "output_text", text: "Summary" }] },
  ] }));
  const manager = new PayloadManager({ maxBytes: 32_000 });
  const req = new Request("http://fixture.invalid/v1/responses", { method: "POST", body: JSON.stringify({ model: "test", input: [
    { role: "user", content: "x".repeat(40_000) }, { role: "user", content: "current" },
  ] }) });
  const result = await manager.prepare(req, manager.maxBytes, async (notice) => { notices.push(notice); });
  assert.deepEqual(notices.map((notice) => notice.kind), ["budget", "summary"]);
  const wire = await result.text();
  for (const notice of notices) assert.ok(!wire.includes(notice.message));
});
