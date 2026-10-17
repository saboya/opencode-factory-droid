import assert from "node:assert/strict";
import { test } from "node:test";
import { Plugin } from "@opencode/plugin";
import { DROID_IDENTITY, ROUTES } from "../src/catalog.ts";
import { registerFactoryHooks } from "../src/hooks.ts";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

test("Factory GPT uses stateless reasoning replay for every request kind", async () => {
  const hooks: Array<{ kind: string; providerID: string; run: (event: any) => unknown }> = [];
  const ctx = {
    session: { hook: async (kind: string, run: (event: any) => unknown, scope: { providerID: string }) => {
      hooks.push({ kind, providerID: scope.providerID, run });
      return { dispose: async () => {} };
    } },
  } as unknown as Context;
  await registerFactoryHooks(ctx, ROUTES.map((r) => r.providerID), {
    key: "fixture-key", providerForModel: () => "openai",
  });
  for (const providerID of ROUTES.map((r) => r.providerID)) {
    for (const kind of ["context", "generate", "title", "compaction"]) {
      const hook = hooks.find((h) => h.kind === kind && h.providerID === providerID)!;
      const event = {
        system: [{ type: "text", text: DROID_IDENTITY }],
        options: { store: true, include: ["web_search_call.action.sources"] },
      };
      await hook.run(event);
      await hook.run(event);
      assert.equal(event.system.length, 1);
      assert.deepEqual(event.options, providerID === "factory-gpt" ? {
        store: false, include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
      } : { store: true, include: ["web_search_call.action.sources"] });
      const defaults = { system: [], options: {} };
      await hook.run(defaults);
      assert.deepEqual(defaults.options, providerID === "factory-gpt" ? {
        store: false, include: ["reasoning.encrypted_content"],
      } : {});
    }
  }
});
