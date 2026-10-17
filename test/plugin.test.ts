import assert from "node:assert/strict";
import { test } from "node:test";
import { Plugin } from "@opencode/plugin";
import plugin from "../src/index.ts";
import { ROUTES, CLIENT_VERSION, providerFor } from "../src/catalog.ts";
import { MULTIPLIER_SOURCE } from "../src/multipliers.ts";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
type Editor = Parameters<Parameters<Context["provider"]["transform"]>[0]>[0];
type Source = Parameters<Editor["add"]>[0];

for (const restricted of [false, true]) {
  test(`V2 provider registration preserves routes and policy (restricted=${restricted})`, async (t) => {
    for (const [key, value] of Object.entries({
      FACTORY_API_KEY: "fixture-key", FACTORY_API_BASE_URL: "http://fixture.invalid/",
    })) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const allowed = ROUTES[0].models[0].id;
    const blocked = ROUTES[0].models[1].id;
    t.mock.method(globalThis, "fetch", async (input: string) => {
      if (input === MULTIPLIER_SOURCE) return new Response("");
      assert.ok(input.endsWith("/api/organization/managed-settings"));
      return Response.json({ settings: { modelPolicy: {
        allowAllFactoryModels: !restricted,
        allowedModelIds: [allowed, blocked],
        blockedModelIds: [blocked],
      } } });
    });
    let transform: ((editor: Editor) => void) | undefined;
    const hooks: Array<{ kind: string; providerID: string }> = [];
    let disposed = 0;
    const registration = () => ({ dispose: async () => { disposed++; } });
    // Deliberately no ctx.catalog: setup must work with the current SDK API.
    const ctx = {
      storage: { get: async () => undefined, set: async () => {} },
      provider: { transform: async (callback: typeof transform) => {
        transform = callback;
        return registration();
      } },
      session: { hook: async (kind: string, _callback: unknown, scope: { providerID: string }) => {
        hooks.push({ kind, providerID: scope.providerID });
        return registration();
      } },
    } as unknown as Context;
    const cleanup = await plugin.setup(ctx);
    assert.ok(transform);
    const replay = () => {
      const sources: Source[] = [];
      transform!({ add: (source: Source) => { sources.push(source); } } as unknown as Editor);
      return sources;
    };
    const sources = replay();
    assert.deepEqual(replay(), sources, "provider transform is repeatable");
    assert.equal(sources.length, restricted ? 1 : 3);
    for (const source of sources) {
      const route = ROUTES.find((r) => r.providerID === source.info.id)!;
      assert.equal(source.info.package, route.package);
      assert.equal(source.info.activation, "enabled");
      assert.deepEqual(source.info.settings, {
        baseURL: `http://fixture.invalid${route.basePath}`, apiKey: "fixture-key",
      });
      assert.equal(source.info.headers?.["x-client-version"], CLIENT_VERSION);
      const expected = route.models.filter((m) => m.id !== blocked && (!restricted || m.id === allowed));
      assert.deepEqual(source.models.map((m) => m.id), expected.map((m) => m.id));
      for (const model of source.models) {
        const spec = expected.find((m) => m.id === model.id)!;
        assert.equal(model.modelID, spec.modelID ?? spec.id);
        assert.equal(model.headers?.["x-api-provider"], providerFor(spec));
        assert.ok(model.name.startsWith(spec.name));
      }
    }
    assert.equal(hooks.length, 18);
    assert.deepEqual([...new Set(hooks.map((h) => h.providerID))], ROUTES.map((r) => r.providerID));
    assert.equal(typeof cleanup, "function");
    if (typeof cleanup === "function") await cleanup();
    assert.equal(disposed, 19);
  });
}
