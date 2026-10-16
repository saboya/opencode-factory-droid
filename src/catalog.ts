/**
 * Factory (Droid) route + model catalog.
 *
 * Pure data — imported by both the plugin (src/index.ts) and the M0 probe
 * (scripts/probe.ts). Keep this module free of @opencode/plugin imports so
 * `node scripts/probe.ts` can load it without OpenCode's runtime.
 *
 * Wire facts (verified by TLS-MITM capturing the real droid CLI, 0.243.0):
 *   - LLM traffic lives on https://prem.factory.ai (not app/api.factory.ai).
 *   - Every route gates on the system prompt starting with DROID_IDENTITY.
 *   - Per-model x-api-provider is required; see FAMILY_PROVIDER/model.provider.
 *   - Header set: authorization Bearer, x-factory-client: cli, x-client-version.
 *
 * Model availability is additionally gated by org policy (managed-settings
 * modelPolicy) and by provider region; the plugin does not hardcode that.
 */

export type RouteID = "anthropic" | "chat" | "responses";

/** Exact, case-sensitive system-prompt prefix Factory's edge requires. */
export const DROID_IDENTITY = "You are Droid, an AI software engineering agent built by Factory.";

/** Droid CLI version whose header set these routes are validated against. */
export const CLIENT_VERSION = "0.243.0";

export interface FactoryModel {
  /** OpenCode model ID (shown as <provider>/<id> in /models). */
  id: string;
  /** Wire ID sent to Factory. Defaults to `id` when omitted. */
  modelID?: string;
  /** Display name. */
  name: string;
  /** Grouping family, e.g. "claude", "gpt", "glm". */
  family: string;
  /** Upstream backend for `x-api-provider`. Defaults to FAMILY_PROVIDER[family]. */
  provider?: string;
  /** Defaults to "active". */
  status?: "alpha" | "beta" | "deprecated" | "active";
  /**
   * Escape-hatch override for context/output limits. Normally omitted: limits
   * come from the generated table (src/models.gen.ts, upstream vendor windows).
   * Set only when models.dev is wrong for a specific model.
   */
  limit?: { context: number; output: number };
}

export interface RouteSpec {
  providerID: "factory" | "factory-o" | "factory-gpt";
  /** Display name in OpenCode. */
  name: string;
  /**
   * AI-SDK package the beta CLI resolves into a LanguageModel. The beta
   * lineage (`0.0.0-beta-*`) only understands `aisdk:`-prefixed packages;
   * native `@opencode/ai/providers/*` values fail schema validation.
   */
  package: string;
  /** Path appended to the base URL; the package appends the verb. */
  basePath: string;
  models: FactoryModel[];
}

/**
 * Default `x-api-provider` per family. These are the "native" backends that
 * Factory accepts for the family (chosen from the server's provider-routing
 * config, preferring non-enterprise providers that work for API-key users).
 */
export const FAMILY_PROVIDER: Record<string, string> = {
  claude: "anthropic",
  gpt: "openai",
  gemini: "google",
  grok: "xai",
  glm: "baseten",
  kimi: "baseten",
  deepseek: "baseten",
  minimax: "fireworks",
  mistral: "mistral",
  inkling: "baseten",
  nemotron: "baseten",
  qwen: "fireworks",
};

/** Resolve the upstream backend for a model. */
export function providerFor(model: FactoryModel): string {
  return model.provider ?? FAMILY_PROVIDER[model.family] ?? "fireworks";
}

const claude = (id: string, name: string, extra: Partial<FactoryModel> = {}): FactoryModel => ({
  id,
  name,
  family: "claude",
  ...extra,
});

const openai = (id: string, name: string, extra: Partial<FactoryModel> = {}): FactoryModel => ({
  id,
  name,
  family: "gpt",
  ...extra,
});

const gemini = (id: string, name: string): FactoryModel => ({ id, name, family: "gemini" });
const grok = (id: string, name: string): FactoryModel => ({ id, name, family: "grok" });
const core = (
  id: string,
  name: string,
  family: string,
  extra: Partial<FactoryModel> = {},
): FactoryModel => ({ id, name, family, ...extra });

export const ROUTES: RouteSpec[] = [
  {
    providerID: "factory",
    name: "Factory (Anthropic)",
    package: "aisdk:@ai-sdk/anthropic",
    basePath: "/api/llm/a/v1",
    models: [
      claude("claude-fable-5.1", "Claude Fable 5.1"),
      claude("claude-fable-5", "Claude Fable 5"),
      claude("claude-opus-5-5", "Claude Opus 5.5"),
      claude("claude-opus-5-5-fast", "Claude Opus 5.5 Fast"),
      claude("claude-opus-5", "Claude Opus 5"),
      claude("claude-opus-5-fast", "Claude Opus 5 Fast"),
      claude("claude-opus-4-8", "Claude Opus 4.8"),
      claude("claude-opus-4-8-fast", "Claude Opus 4.8 Fast"),
      claude("claude-opus-4-7", "Claude Opus 4.7"),
      claude("claude-opus-4-6", "Claude Opus 4.6"),
      claude("claude-sonnet-5-5", "Claude Sonnet 5.5"),
      claude("claude-sonnet-5", "Claude Sonnet 5"),
      claude("claude-sonnet-4-6", "Claude Sonnet 4.6"),
      claude("claude-haiku-5-5", "Claude Haiku 5.5"),
    ],
  },
  {
    providerID: "factory-o",
    name: "Factory (OpenAI-compatible)",
    package: "aisdk:@ai-sdk/openai-compatible",
    basePath: "/api/llm/o/v1",
    models: [
      gemini("gemini-3.1-pro-preview", "Gemini 3.1 Pro"),
      gemini("gemini-3.8-flash", "Gemini 3.8 Flash"),
      gemini("gemini-4-argon", "Gemini 4 Argon"),
      grok("grok-4.7", "Grok 4.7"),
      grok("grok-4.6", "Grok 4.6"),
      core("inkling", "Inkling", "inkling"),
      core("mistral-medium-3.5", "Mistral Medium 3.5", "mistral"),
      core("mistral-large-4", "Mistral Large 4", "mistral"),
      core("glm-5.3-flash", "GLM-5.3-Flash", "glm", { provider: "fireworks" }),
      core("glm-5.3", "GLM-5.3", "glm"),
      core("glm-5.2", "GLM-5.2", "glm"),
      core("glm-5.2-fast", "GLM-5.2 Fast", "glm"),
      core("kimi-k3", "Kimi K3", "kimi", { provider: "fireworks" }),
      core("kimi-k2.7-code", "Kimi K2.7 Code", "kimi"),
      core("qwen3.8-max", "Qwen3.8 Max", "qwen"),
      core("nemotron-3-ultra", "Nemotron 3 Ultra", "nemotron"),
      core("minimax-m3", "MiniMax M3", "minimax"),
      core("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "deepseek"),
      core("deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", "deepseek", { provider: "fireworks" }),
      core("deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek", { provider: "fireworks" }),
    ],
  },
  {
    providerID: "factory-gpt",
    name: "Factory (OpenAI Responses)",
    package: "aisdk:@ai-sdk/openai",
    basePath: "/api/llm/o/v1",
    models: [
      openai("gpt-6.1-sol", "GPT-6.1 Sol"),
      openai("gpt-6-astra", "GPT-6 Astra"),
      openai("gpt-6-sol", "GPT-6 Sol"),
      openai("gpt-6-luna", "GPT-6 Luna"),
      openai("gpt-5.6-sol", "GPT-5.6 Sol"),
      openai("gpt-5.6-terra", "GPT-5.6 Terra"),
      openai("gpt-5.6-luna", "GPT-5.6 Luna"),
      openai("gpt-5.5", "GPT-5.5"),
      openai("gpt-5.3-codex", "GPT-5.3-Codex"),
      openai("gpt-5.2", "GPT-5.2"),
    ],
  },
];

/** Cheap models used for header/system/reasoning probing (low quota multipliers). */
export const PROBE_CHEAP: Record<RouteID, string> = {
  anthropic: "claude-haiku-5-5",
  chat: "glm-5.3-flash",
  responses: "gpt-6-luna",
};

export function routeID(route: RouteSpec): RouteID {
  return route.providerID === "factory" ? "anthropic" : route.providerID === "factory-o" ? "chat" : "responses";
}
