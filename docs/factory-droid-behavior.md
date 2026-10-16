# Factory (Droid) — Provider Behavior Reference

_All hard-won wire facts about Factory's premium LLM gateway, consolidated from live
probing. An agent starting this task from scratch should read this first; it saves days
of probing. Every claim here was verified on the wire against the real service unless
explicitly marked otherwise._

_Last verified: 2026-10-16, against `factory-cli` 0.243.0, account region `fra1`._

---

## 1. What Factory is (in this context)

Factory (product: **Droid**) is a commercial AI coding agent. A Factory **subscription**
grants access to a premium LLM gateway that proxies many model families (Claude, GPT,
Gemini, GLM, Kimi, Qwen, DeepSeek, MiniMax, Mistral, Grok, …) behind a single API key.
The gateway is **not** a plain OpenAI/Anthropic-compatible relay: it enforces an agent
identity on every request (the "WAF gate", §4), requires routing headers (§5), and is
the same gateway the official `droid` CLI uses.

This project (`opencode-factory`) exposes that gateway as OpenCode providers. The
official CLI is the reference implementation — everything below was derived by
observing what the real CLI sends, then re-verifying with minimal probe requests.

## 2. Endpoints

**LLM traffic base: `https://prem.factory.ai`**
(`app.factory.ai` and `api.factory.ai` return **403** for LLM calls — the gateway is
only `prem.*`. Web-app/API traffic for everything else goes to `app.factory.ai`.)

| Route | Path | Protocol |
|---|---|---|
| Anthropic | `/api/llm/a/v1/messages` | Anthropic Messages |
| OpenAI-compatible | `/api/llm/o/v1/chat/completions` | OpenAI Chat Completions |
| OpenAI Responses | `/api/llm/o/v1/responses` | OpenAI Responses |

Also present (not used by this plugin): `…/embeddings`, `…/images/*`.

**Non-LLM endpoints observed** (from running the real CLI through a MITM proxy — see
the playbook doc): `/api/feature-flags`, `/api/organization/managed-settings`,
`/api/cli/whoami`, `/api/billing/limits`, `/api/ingest`,
`/api/connectors/tools/revision`, `/api/apps/cloud-sync/sessions…` (session telemetry).
Of these, `feature-flags` carries the **provider routing table** (§5) and
`managed-settings` carries the **org model policy** (§7).

**Env overrides honored by the official CLI** (discovered by static string extraction
of the binary, then verified): `FACTORY_API_BASE_URL` (and `FACTORY_API_BASE_URL_EU`),
`FACTORY_APP_BASE_URL`, `FACTORY_EXTRA_CA_CERTS`, `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`.
The plugin honors `FACTORY_API_BASE_URL` too — this is the hook used for wire-level
debugging (point it at a local capture proxy).

## 3. Authentication

- Wire auth is **`authorization: Bearer <key>`** with the Factory API key
  (`fk-…`, from <https://app.factory.ai/settings/api-keys>).
- The Anthropic route accepts **bearer only**: sending `x-api-key` without
  `authorization` → `401 Missing authorization token`. Sending `x-api-key` *alongside*
  a valid bearer is tolerated (the `@ai-sdk/anthropic` SDK sends both — fine).
- There is no OAuth requirement for API-key usage. (The official CLI can do an
  OAuth/WorkOS device flow; out of scope here — this plugin uses
  `FACTORY_API_KEY` env var only and fails fast when unset.)

## 4. The WAF gate (the single biggest gotcha)

Factory rejects with **403** any LLM request whose system prompt does **not begin
with, exactly**:

```
You are Droid, an AI software engineering agent built by Factory.
```

Properties, all verified by probing (`prefix-probe.mjs` / `waf-probe.mjs`):

- **Case- and punctuation-sensitive**, must be at **offset 0** of the gated field.
  A leading space/newline, a missing period, lowercase `you`/`droid`, or any preamble
  before it → 403.
- **Anything after it is free.** Appending OpenCode's own system prompt, tool
  definitions preamble, etc. after the identity line → 200. (Tested: appending
  "You are opencode…", "You are Claude Code…" after the identity still passes.)
- **Per-protocol gated field** — this is where the identity must live:

| Protocol | Gated field | Trap |
|---|---|---|
| Anthropic `/messages` | top-level `system` (string **or** content-block array; blocks: first block must be `{type:"text",text:…}` starting with identity) | — |
| Chat `/chat/completions` | **first** `messages[]` entry with `role:"system"` (string content) | a `user`/`developer` message carrying the text does **not** satisfy it |
| Responses `/responses` | top-level **`instructions`** | **`input` does not count** — any `input` entry with role `system`/`developer`/`user` (string or array content) 403s |

- **Every** LLM call is gated, including OpenCode's **title generation** and
  (presumably) compaction requests — not just the main turn. This bites because
  OpenCode's own system prompt obviously doesn't contain the Droid identity; see §8.
- Error shape: `403 {"detail":"Forbidden","status":403,"title":"…","requestId":"…"}`.

## 5. Headers

Verified required / tolerated on the wire (reference: real CLI 0.243.0 traffic and
plugin traffic through the capture proxy):

**Effectively required**

| Header | Value | Failure mode if wrong/missing |
|---|---|---|
| `authorization` | `Bearer <key>` | 401 `Missing authorization token` |
| `content-type` | `application/json` | — |
| `x-factory-client` | `cli` | (sent by CLI; enforced by proxy for legitimacy) |
| `x-client-version` | `0.243.0` | must match the CLI version you impersonate |
| `user-agent` | `factory-cli/0.243.0` | (sent by CLI) |
| `x-api-provider` | backend name, per model (§6) | OpenAI routes: `400 Missing x-api-provider header`; bad value: `400 Invalid x-api-provider` |

**Not required** (tolerated, can be omitted): `openai-platform`, `x-session-id`,
`x-assistant-message-id`, `traceparent`, `x-stainless-*`, `x-provider-routing-source`,
`accept: application/json`.

`x-client-version` / `x-factory-client` / `user-agent` are version-locked to the CLI
version you mirrored (`CLIENT_VERSION = "0.243.0"` in `src/catalog.ts`). If Factory
bumps enforcement, this is the constant to update.

## 6. Provider routing (`x-api-provider`)

The gateway fans each model out to a **named upstream backend** per request. The full
routing table comes from `GET /api/feature-flags` (`provider_routing` key: per-model
ordered backend lists with `defaults` fallbacks; a copy is in
`factory-inspect/routing.json` in the temp scratch dir).

Validated for this account (region `fra1`) by direct probing:

| Family | Working `x-api-provider` |
|---|---|
| claude | `anthropic` (also `azure_anthropic`, `bedrock_anthropic`, `snowflake`, `vertex_anthropic`) |
| gpt | `openai` (also `azure_openai` — required for some `gpt-5.5`-class models) |
| gemini | `google` |
| glm, deepseek | `baseten` (some models also `fireworks`) |
| kimi, minimax, qwen | `fireworks` |
| mistral | `mistral` |
| **grok** | **unresolved** — `xai` → `400 Invalid x-api-provider`; others → `400 Provider not available in this region`. Deferred. |

Notes:

- The server resolves routing **per account/region**, so no single hardcoded value is
  universally correct. The plugin uses `FAMILY_PROVIDER` in `src/catalog.ts` with
  per-model overrides (`model.provider`) where probing demanded it (e.g. `glm-5.3-flash`
  → `fireworks`). Rotation/fallback on `Invalid x-api-provider` is deferred (M3+).
- The Anthropic route tolerates a missing `x-api-provider` (defaults server-side), but
  the plugin sends it everywhere for uniformity.

## 7. Org policy (`managed-settings`)

`GET https://app.factory.ai/api/organization/managed-settings` (bearer + the
standard factory client headers) returns the org's model policy under
`settings.modelPolicy`:

```json
{ "allowAllFactoryModels": false,
  "allowedModelIds": ["…28 ids…"],
  "blockedModelIds": ["…16 ids…"] }
```

Rules the gateway enforces **per request**:
- a model in `blockedModelIds` is denied;
- when `allowAllFactoryModels` is `false`, a model **not** listed in
  `allowedModelIds` is denied;
- otherwise allowed.

A denied model returns:
`403 {"detail":"This model is not available due to your organization's security settings","status":403,"requestId":…}`
— distinct from the WAF 403 (§4), which is an identity problem.

For this account (`allowAllFactoryModels:false`, 28 allowed / 16 blocked) that means
**23 of the 44 catalog models are unusable**: 4 explicitly blocked + 19 off-allowlist.

**The plugin now filters the catalog to this policy** (`src/policy.ts`,
`loadModelPolicy()` + `modelAllowed()`, wired in `src/index.ts`): the policy is
fetched once at `setup()`, cached to `ctx.storage` under `factory/model-policy`, and
the registered catalog is reduced to allowed models (this account → **21 models**,
6/10/5). On fetch failure it uses the cached policy; with no cache it **fails open**
(registers the full catalog). Override the app base with `FACTORY_APP_BASE_URL`.

Note `isFastModelsAllowed: false` also appears in the policy. Region availability is
separate and not in this document — see the grok note in §6/HANDOFF §7.

## 8. How the plugin satisfies all of the above

Three hook layers per provider (all in `src/hooks.ts`, scoped by `{providerID}`):

1. **Session hooks** (`context`, `generate`, `title`, `compaction`): prepend
   `DROID_IDENTITY` to the mutable `system: SystemPart[]`.
   ⚠️ On CLI `0.0.0-beta-19242` these two kinds **do not fire** for title-generation
   requests even though the request happens — verified by hook-firing trace. Do not
   rely on this layer alone.
2. **`model.request` hook**: force wire headers — `authorization: Bearer`,
   `x-factory-client: cli`, `x-client-version: 0.243.0`, per-model `x-api-provider`.
3. **`http.request` hook**: **body rewrite fallback** — parse the JSON body and
   prepend `DROID_IDENTITY` to the protocol's gated field idempotently
   (`injectIdentity()`: top-level `system` / first system `messages[]` entry /
   top-level `instructions`). This is the layer that actually fixes title-request 403s
   and covers any request path (title, compaction, main) regardless of which session
   hook kinds fire.

Plus belt-and-braces at registration: provider `settings.apiKey` + provider `headers`
(`src/index.ts`), even though the `model.request` hook alone suffices.

## 9. Chat vs Responses route selection

There is **no** per-model setting that selects chat-vs-responses. The bundled
`@ai-sdk/openai` package picks the **Responses API by model-ID pattern** — verified:
`factory-gpt/gpt-6-luna` → `/api/llm/o/v1/responses` with no extra settings. The
`factory-o` route uses `@ai-sdk/openai-compatible`, which always does chat completions.
Two providers therefore share `basePath /api/llm/o/v1` but speak different protocols.

## 10. Errors & status-code taxonomy

Errors are JSON: `{detail, status, title, requestId}`.

| Status | Meaning | Fix |
|---|---|---|
| 401 | missing/invalid `authorization` | send bearer |
| 402 | quota/billing (expected for 402 mapping in M2 `retry` hook) | — |
| 403 | WAF gate — identity missing/not at offset 0 in gated field | §4 |
| 403 `"…not available due to your organization's security settings"` | model outside org policy | §7 (plugin filters these out) |
| 400 `Missing x-api-provider header` | OpenAI route without routing header | §6 |
| 400 `Invalid x-api-provider` | wrong backend for model/region | §6 |
| 400 `Provider not available in this region` | backend not offered in region | §6 |
| 429 | rate limit (honor `Retry-After`, M2 `retry` hook) | — |

## 11. Model catalog (current)

Three OpenCode providers. The catalog defines 44 models total, but the plugin
**registers only the policy-allowed subset** (21 for this account); the counts below
are the full catalog:

- **`factory`** — Anthropic route, `aisdk:@ai-sdk/anthropic`, 14 models: Claude
  Fable/Opus/Sonnet/Haiku families incl. `*-fast` variants (6 registered here).
- **`factory-o`** — chat route, `aisdk:@ai-sdk/openai-compatible`, 20 models: Gemini,
  Grok, Inkling, Mistral, GLM, Kimi, Qwen, Nemotron, MiniMax, DeepSeek (10 registered).
- **`factory-gpt`** — Responses route, `aisdk:@ai-sdk/openai`, 10 models: GPT-6.x /
  5.x (5 registered).

Catalog data is pure static data in `src/catalog.ts` (no `@opencode/plugin` import, so
`node scripts/probe.ts` can load it standalone). `PROBE_CHEAP` holds the cheap probe
model per route (`claude-haiku-5-5` / `glm-5.3-flash` / `gpt-6-luna`).

### Cost & limit metadata

Factory exposes **no USD/token prices** — it bills subscription quota (the
`/api/billing/limits` + `feature-flags` responses carry quota/limits, not price
tables; observed via MITM). So OpenCode's spend display uses **upstream vendor list
prices** (Anthropic/OpenAI/Google/Zhipu/…) sourced from the models.dev dataset and
generated into `src/models.gen.ts` by `scripts/gen-models.mjs`, which emits **both**:

- `COSTS` — `Model.Cost[]` (USD/Mtok), used by OpenCode's spend display.
- `LIMITS` — `{context, input?, output}` per model, used by OpenCode for **compaction
  timing**. These are the upstream vendor windows (what the model really accepts);
  Factory proxies to the vendor limit. A too-small value causes premature compaction,
  a too-large value risks context-overflow 400s.

Caveats:

- Costs are what the tokens cost **at the upstream vendor**, not what Factory
  charges — real Factory spend is quota burn against the plan, not these numbers.
- `*-fast` models inherit the base model's price **and limits** (fast routing, same
  tokens).
- Canonical vendors only (never resellers — their prices diverge 50×); unresolvable
  models abort generation rather than silently picking a reseller. A few judgment
  calls are inlined as comments in `src/models.gen.ts` (e.g. `claude-fable-5.1` ←
  `claude-fable-5-1`, `mistral-medium-3.5` ← `mistral-medium-2604`, Inkling from a
  reseller because it has no first-party listing).
- Tiered pricing (e.g. GPT-6 above 272k context, Claude Haiku above 100k) maps to
  schema `cost[]` entries with `tier: {type:"context", size}`.
- `FactoryModel.limit` in `src/catalog.ts` is now an **escape-hatch override only**
  (normally omitted; generated limits apply).
- Regenerate with `node scripts/gen-models.mjs [models.dev api.json]` when the
  catalog or upstream data changes.

**Cheap-probe etiquette:** all probing should use `max_tokens`/`max_output_tokens` ≤ 32
and the `PROBE_CHEAP` models to minimize subscription-quota burn.

## 12. Reproduction commands

```sh
export PATH="/Users/saboya/.npm-packages/bin:$PATH"
cd /Users/saboya/projects/saboya/opencode-droid

# control (known-good model) vs our three routes
opencode2 run --standalone -m opencode/cat-jam-free      "say pong"
opencode2 run --standalone -m factory/claude-haiku-5-5   "say pong"
opencode2 run --standalone -m factory-o/glm-5.3-flash    "say pong"
opencode2 run --standalone -m factory-gpt/gpt-6-luna     "say pong"
opencode2 models | grep factory
```

Wire-level verification (see playbook §"capture proxy"):

```sh
cd /private/var/folders/71/75c4n_4j5r178d8z695vxr880000gn/T/opencode/factory-inspect
CAPTURE_REAL=https://prem.factory.ai CAPTURE_LOG=capture2.log node capture-status-proxy.mjs &
export FACTORY_API_BASE_URL="http://127.0.0.1:8787"
opencode2 run --standalone -m factory/claude-haiku-5-5 "say pong"
# capture2.log now shows status + headers + first 6KB of each body per request
```
