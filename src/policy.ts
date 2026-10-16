/**
 * Factory organization model policy.
 *
 * The Factory gateway enforces the org's model policy **per request**: a model
 * that is blocked or absent from the allowlist returns
 *   403 {"detail":"This model is not available due to your organization's security settings"}
 * The policy is published (authenticated) at
 *   GET https://app.factory.ai/api/organization/managed-settings
 * under `settings.modelPolicy`:
 *   { allowAllFactoryModels: boolean, allowedModelIds: string[], blockedModelIds: string[] }
 *
 * We fetch it once per setup and filter the registered catalog so /models only
 * lists models the account can actually call. Verified empirically: with
 * `allowAllFactoryModels: false`, models sampled from outside the allowlist all
 * returned the 403 above, and every catalog model in `blockedModelIds` did too.
 *
 * Failure policy: on any fetch/parse error use the last cached policy
 * (ctx.storage); with no cache at all, fail **open** (register the full catalog)
 * — showing a few unusable models is less harmful than hiding working ones.
 *
 * Keep this module free of @opencode/plugin imports (store is injected) so plain
 * `node` can load and unit-test it.
 */

import { CLIENT_VERSION } from "./catalog";

export interface ModelPolicy {
  readonly allowAll: boolean;
  readonly allowed: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
}

/** Serializable cache shape (Schema.Json compatible). */
export interface ModelPolicyCache {
  readonly allowAll: boolean;
  readonly allowed: string[];
  readonly blocked: string[];
  readonly fetchedAt: string;
}

/** Injected persistence (wired to ctx.storage in src/index.ts). */
export interface ModelPolicyStore {
  read(): Promise<ModelPolicyCache | undefined>;
  write(value: ModelPolicyCache): Promise<void>;
}

export const POLICY_CACHE_KEY = "factory/model-policy";
export const POLICY_PATH = "/api/organization/managed-settings";
const ENV_APP_BASE = "FACTORY_APP_BASE_URL";
const DEFAULT_APP_BASE = "https://app.factory.ai";

/** Non-LLM app API base (policy/feature-flags live here, not on prem.factory.ai). */
export function appBaseURL(): string {
  const fromEnv = process.env[ENV_APP_BASE];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "");
  return DEFAULT_APP_BASE;
}

/** True when `modelID` may be used under `policy` (a null policy allows all). */
export function modelAllowed(policy: ModelPolicy | null, modelID: string): boolean {
  if (!policy) return true;
  if (policy.blocked.has(modelID)) return false;
  return policy.allowAll || policy.allowed.has(modelID);
}

function toPolicy(cache: ModelPolicyCache): ModelPolicy {
  return { allowAll: cache.allowAll, allowed: new Set(cache.allowed), blocked: new Set(cache.blocked) };
}

function parsePolicy(json: unknown): ModelPolicyCache | null {
  if (typeof json !== "object" || json === null) return null;
  const settings = (json as { settings?: unknown }).settings;
  if (typeof settings !== "object" || settings === null) return null;
  const policy = (settings as { modelPolicy?: unknown }).modelPolicy;
  if (typeof policy !== "object" || policy === null) return null;
  const p = policy as { allowAllFactoryModels?: unknown; allowedModelIds?: unknown; blockedModelIds?: unknown };
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    allowAll: p.allowAllFactoryModels === true,
    allowed: strList(p.allowedModelIds),
    blocked: strList(p.blockedModelIds),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchPolicy(key: string, base: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`${base}${POLICY_PATH}`, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "user-agent": `factory-cli/${CLIENT_VERSION}`,
      "x-factory-client": "cli",
      "x-client-version": CLIENT_VERSION,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`managed-settings: HTTP ${res.status}`);
  return res.json();
}

async function readCache(store: ModelPolicyStore | undefined): Promise<ModelPolicyCache | undefined> {
  if (!store) return undefined;
  try {
    return await store.read();
  } catch {
    return undefined;
  }
}

async function writeCache(store: ModelPolicyStore | undefined, value: ModelPolicyCache): Promise<void> {
  if (!store) return;
  try {
    await store.write(value);
  } catch {
    /* best effort */
  }
}

export interface LoadPolicyOptions {
  key: string;
  store?: ModelPolicyStore;
  base?: string;
  timeoutMs?: number;
}

/**
 * Fetch the org policy, falling back to the cached copy. Returns `null` when
 * neither is available (caller then registers the unfiltered catalog).
 */
export async function loadModelPolicy(opts: LoadPolicyOptions): Promise<ModelPolicy | null> {
  const base = opts.base ?? appBaseURL();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cached = await readCache(opts.store);
  try {
    const fresh = parsePolicy(await fetchPolicy(opts.key, base, timeoutMs));
    if (fresh) {
      await writeCache(opts.store, fresh);
      return toPolicy(fresh);
    }
  } catch {
    /* fall through to cache */
  }
  return cached ? toPolicy(cached) : null;
}
