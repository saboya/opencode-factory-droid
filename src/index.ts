import { Model, Plugin, Provider } from "@opencode/plugin";
import { CLIENT_VERSION, ROUTES, providerFor, type FactoryModel, type RouteSpec } from "./catalog";
import { COSTS, LIMITS } from "./models.gen";
import {
  loadModelPolicy,
  modelAllowed,
  POLICY_CACHE_KEY,
  type ModelPolicyCache,
  type ModelPolicyStore,
} from "./policy";
import { registerFactoryHooks } from "./hooks";

const ENV_KEY = "FACTORY_API_KEY";
const ENV_BASE = "FACTORY_API_BASE_URL";
const DEFAULT_BASE = "https://prem.factory.ai";

function requireKey(): string {
  const key = process.env[ENV_KEY];
  if (!key || key.trim().length === 0) {
    throw new Error(
      `opencode-factory: ${ENV_KEY} is not set. Export a Factory API key ` +
        `(https://app.factory.ai/settings/api-keys) before starting OpenCode.`,
    );
  }
  return key;
}

function baseURL(): string {
  const fromEnv = process.env[ENV_BASE];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "");
  return DEFAULT_BASE;
}

function toModel(providerID: Provider.ID, m: FactoryModel): Model.Info {
  const cost = COSTS[m.id];
  const limit = m.limit ?? LIMITS[m.id];
  return {
    ...Model.Info.default(providerID, Model.ID.make(m.id)),
    modelID: Model.ID.make(m.modelID ?? m.id),
    name: m.name,
    family: m.family as Model.Family,
    headers: { "x-api-provider": providerFor(m) },
    ...(m.status ? { status: m.status } : {}),
    // Context/output windows: catalog escape-hatch override, else generated
    // upstream vendor limits (src/models.gen.ts).
    ...(limit ? { limit } : {}),
    // Upstream list prices (models.dev) for OpenCode's spend display; generated
    // in src/models.gen.ts — see that file's header for provenance and caveats.
    ...(cost ? { cost } : {}),
  };
}

function toProvider(route: RouteSpec, base: string, key: string) {
  const providerID = Provider.ID.make(route.providerID);
  return {
    info: {
      ...Provider.Info.empty(providerID),
      name: route.name,
      activation: "enabled" as const,
      package: route.package,
      settings: { baseURL: `${base}${route.basePath}`, apiKey: key },
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": `factory-cli/${CLIENT_VERSION}`,
        "x-factory-client": "cli",
        "x-client-version": CLIENT_VERSION,
      },
    },
    models: route.models.map((m) => toModel(providerID, m)),
  };
}

export default Plugin.define({
  id: "opencode-factory",
  async setup(ctx) {
    const key = requireKey();
    const base = baseURL();
    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    // Fetch the org's model policy and drop models the account cannot call
    // (they 403 at request time). Fetched once per setup; cached in storage so a
    // transient failure falls back to the last known policy (see src/policy.ts).
    const store: ModelPolicyStore = {
      read: async () => {
        const value = await ctx.storage.get(POLICY_CACHE_KEY);
        return value as ModelPolicyCache | undefined;
      },
      write: async (value) => {
        await ctx.storage.set(POLICY_CACHE_KEY, value as unknown as Parameters<typeof ctx.storage.set>[1]);
      },
    };
    const policy = await loadModelPolicy({ key, store });

    // Register the three Factory routes as providers. `CatalogEditor.update`
    // upserts, so re-running setup refreshes names, packages, headers and the
    // model list in place; policy-excluded models are removed so a re-run after a
    // policy change also drops them.
    registrations.push(
      await ctx.catalog.transform((editor) => {
        for (const route of ROUTES) {
          const models = route.models.filter((m) => modelAllowed(policy, m.id));
          if (models.length > 0) {
            const provider = toProvider({ ...route, models }, base, key);
            editor.provider.update(route.providerID, (p) => {
              Object.assign(p, provider.info);
            });
            for (const model of provider.models) {
              editor.model.update(route.providerID, model.modelID, (m) => {
                Object.assign(m, model);
              });
            }
          }
          for (const m of route.models) {
            if (!modelAllowed(policy, m.id)) {
              editor.model.remove(route.providerID, Model.ID.make(m.modelID ?? m.id));
            }
          }
        }
      }),
    );

    // Factory gates every LLM call on the Droid identity and requires specific
    // wire headers; see src/hooks.ts.
    registrations.push(
      ...(await registerFactoryHooks(
        ctx,
        ROUTES.map((r) => r.providerID),
        { key, providerForModel: (modelID) => FACTORY_MODEL_PROVIDER.get(modelID) ?? "" },
      )),
    );

    return async () => {
      for (const r of registrations.reverse()) await r.dispose();
    };
  },
});

/** Wire modelID -> `x-api-provider` backend, built once from the catalog. */
const FACTORY_MODEL_PROVIDER: ReadonlyMap<string, string> = new Map(
  ROUTES.flatMap((route) => route.models.map((m) => [m.modelID ?? m.id, providerFor(m)] as const)),
);
