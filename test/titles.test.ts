import assert from "node:assert/strict";
import { test } from "node:test";
import { Plugin } from "@opencode/plugin";
import { registerFreeTitles, selectFreeTitleModel } from "../src/titles.ts";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
type ListedModel = Awaited<ReturnType<Context["model"]["list"]>>["data"][number];
const model = (id: string, extra = {}): ListedModel => ({
  id, providerID: "opencode", enabled: true,
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  capabilities: { input: ["text"], output: ["text"] }, ...extra,
} as ListedModel);

test("uses OpenCode's free-only preference, never another provider or paid model", () => {
  const models = [model("glm-5.3-flash-free"), model("big-pickle"), model("deepseek-v4.1-flash-free")];
  assert.equal(selectFreeTitleModel(models)?.id, "big-pickle");
  assert.equal(selectFreeTitleModel(models.filter((m) => m.id !== "big-pickle"))?.id, "deepseek-v4.1-flash-free");
  assert.equal(selectFreeTitleModel([
    model("big-pickle", { providerID: "factory" }),
    model("big-pickle", { enabled: false }),
    model("paid", { cost: [{ input: 0, output: 1 }] }),
    model("unknown-price", { cost: [] }),
    model("image", { capabilities: { input: ["image"], output: ["image"] } }),
  ]), undefined);
});

test("changes only the title agent, preserves explicit overrides, and disposes", async () => {
  let transform: Parameters<Context["agent"]["transform"]>[0] | undefined;
  let disposed = false;
  const registration = await registerFreeTitles({
    model: { list: async () => ({ data: [model("big-pickle")] }) },
    agent: { transform: async (callback: typeof transform) => {
      transform = callback;
      return { dispose: async () => { disposed = true; } };
    } },
  } as unknown as Context);
  const apply = (agent: { model?: unknown }) => transform!({ update: (id: string, update: (value: unknown) => void) => {
    assert.equal(id, "title");
    update(agent);
  } } as Parameters<NonNullable<typeof transform>>[0]);
  const title = {};
  apply(title);
  assert.deepEqual(title, { model: { providerID: "opencode", id: "big-pickle" } });
  const configured = { model: { providerID: "custom", id: "explicit" } };
  apply(configured);
  assert.deepEqual(configured.model, { providerID: "custom", id: "explicit" });
  await registration.dispose();
  assert.ok(disposed);
});

test("no free model skips automatic titles instead of spending subscription quota", async () => {
  let hook: ((event: { result?: string }) => Promise<void>) | undefined;
  let explicit = false;
  await registerFreeTitles({
    model: { list: async () => ({ data: [] }) },
    agent: { get: async () => ({ data: { model: explicit ? { id: "custom" } : undefined } }) },
    session: { hook: async (kind: string, callback: typeof hook) => {
      assert.equal(kind, "title"); hook = callback;
      return { dispose: async () => {} };
    } },
  } as unknown as Context);
  const event: { result?: string } = {};
  await hook!(event);
  assert.equal(event.result, "");
  explicit = true;
  const overridden = {};
  await hook!(overridden);
  assert.deepEqual(overridden, {});
});
