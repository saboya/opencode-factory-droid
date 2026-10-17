import { Model, Plugin, Provider } from "@opencode/plugin";
import { CLIENT_VERSION, ROUTES, providerFor, type FactoryModel, type RouteSpec } from "./catalog";
import { COSTS, LIMITS } from "./models.gen";
import { loadMultipliers, multiplierName, MULTIPLIER_CACHE_KEY, type MultiplierTable } from "./multipliers";
import {
  loadModelPolicy,
  modelAllowed,
  POLICY_CACHE_KEY,
  type ModelPolicyCache,
  type ModelPolicyStore,
} from "./policy";
import { registerFactoryHooks } from "./hooks";
import { registerFreeTitles } from "./titles";

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

function toModel(providerID: Provider.ID, m: FactoryModel, multipliers: MultiplierTable): Model.Info {
  const cost = COSTS[m.id];
  const limit = m.limit ?? LIMITS[m.id];
  return {
    ...Model.Info.default(providerID, Model.ID.make(m.id)),
    modelID: Model.ID.make(m.modelID ?? m.id),
    name: multiplierName(m.name, m.modelID ?? m.id, multipliers),
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

function toProvider(route: RouteSpec, base: string, key: string, multipliers: MultiplierTable) {
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
    models: route.models.map((m) => toModel(providerID, m, multipliers)),
  };
}

export default Plugin.define({
  id: "opencode-factory",
  async setup(ctx) {
    const key = requireKey();
    const base = baseURL();
    const registrations: Array<{ dispose: () => Promise<void> }> = [];
    registrations.push(await registerFreeTitles(ctx));

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
    const [policy, multipliers] = await Promise.all([
      loadModelPolicy({ key, store }),
      loadMultipliers({
        store: {
          read: () => ctx.storage.get(MULTIPLIER_CACHE_KEY),
          write: (value) => ctx.storage.set(
            MULTIPLIER_CACHE_KEY, value as unknown as Parameters<typeof ctx.storage.set>[1],
          ),
        },
      }),
    ]);

    // Publish each route's complete source inventory through the V2 provider
    // API. Rebuilds replay this transform, so excluded models never enter it.
    registrations.push(
      await ctx.provider.transform((editor) => {
        for (const route of ROUTES) {
          const models = route.models.filter((m) => modelAllowed(policy, m.id));
          if (models.length > 0) {
            editor.add(toProvider({ ...route, models }, base, key, multipliers));
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
