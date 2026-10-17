# opencode-factory — Handoff

_Last updated: 2026-10-17 (model multiplier display). Written for an agent picking this up cold._

> **Companion docs** — `docs/factory-droid-behavior.md` (all verified Factory wire
> behavior, consolidated) and `docs/reverse-engineering-playbook.md` (generic
> methodology for doing this against another provider). This HANDOFF stays
> authoritative for *project state*; the docs are authoritative for *knowledge*.

## 1. Objective

Build an **OpenCode V2 plugin** ("`opencode-factory`") that exposes a user's **Factory (Droid)
subscription** as OpenCode model providers — i.e. the Factory droid models appear in
OpenCode's model list and requests are proxied to Factory's premium LLM gateway using the
user's Factory API key.

Non-goals / already-decided scope:
- **Shape A only**: Factory models registered as an OpenCode *provider* (no delegation/exec).
- Fresh, minimal build. V2 Plugin API only. Study prior art (`droid-oauth-opencode`) but do
  **not** depend on it.
- Auth: **`FACTORY_API_KEY` env var only**. No OAuth / CLI-credential flow. If the env var is
  missing the plugin must fail fast with a clear error. ✅ **Done** — `setup()` throws
  `"opencode-factory: FACTORY_API_KEY is not set. …"`, which surfaces as a
  `failed to load plugin` WARN in logs (and "Model unavailable" at the CLI surface).
- Include the **OpenAI Responses** route (GPT-6.x / GPT-5.x), plus Anthropic and
  OpenAI-chat-completions routes. ✅ **All three routes verified working end-to-end.**
- Do **not** investigate subscription-quota-vs-billing; just use the key provided.
- Keep Factory quirks isolated in `src/catalog.ts` / `src/hooks.ts` for cheap patching.

## 2. TL;DR — where we are right now

**M1 is complete; M2 robustness started.** The plugin loads, registers the three providers,
and all three routes stream real replies through Factory with correct headers and WAF identity on
**both** main and title-generation requests. As of this session the catalog is also **filtered to
the org's model policy** (21 of 44 models usable for this account) and carries **real
context/output limits**:

```
opencode2 run --standalone -m factory/claude-haiku-5-5   "say pong"  ->  Pong, exit 0
opencode2 run --standalone -m factory-o/glm-5.3-flash    "say pong"  ->  pong, exit 0
opencode2 run --standalone -m factory-gpt/gpt-6-luna     "say pong"  ->  pong, exit 0
opencode2 run --standalone -m factory/claude-haiku-5-5   "run: echo agentic-pong via shell tool"
                                                          ->  tool call round-trip works, exit 0
opencode2 models   # 21 policy-clean models (6 factory/ + 10 factory-o/ + 5 factory-gpt/)
```

The previous blocker (`Schema validation failed: Pointer ["model"] InvalidType expected
"LLM.LanguageModel"`) is **fixed** by re-targeting provider `package` values at AI-SDK
packages (`aisdk:@ai-sdk/anthropic`, `aisdk:@ai-sdk/openai-compatible`,
`aisdk:@ai-sdk/openai`) — the beta CLI resolves those into real `LanguageModel`s.

## 3. The two API lineages (this is the crux)

There are **two incompatible OpenCode V2 plugin/provider APIs** in the wild. Mixing them is
what caused most of the earlier debugging.

| | **Installed CLI (what we target)** | **Docs at opencode.ai/v2** |
|---|---|---|
| CLI version | `@opencode-ai/cli` `0.0.0-beta-19242` (binary: `opencode2`) | (would be `2.x`) |
| Domain name | `ctx.catalog` | `ctx.provider` / `ctx.model` |
| Add a provider | `ctx.catalog.transform(editor => editor.provider.update(id, p => …))` (upsert) | `ctx.provider.transform(editor => editor.add({info, models}))` |
| Add a model | `editor.model.update(providerID, modelID, m => …)` (upsert) | part of `editor.add`/`models.set` |
| Provider `package` | **`aisdk:@ai-sdk/<pkg>`** (AI-SDK) | **`@opencode/ai/providers/<pkg>`** (native) |
| Matching plugin pkg | `@opencode/plugin@0.0.0-beta-19507` | `@opencode/plugin@2.0.31` (latest) |

Evidence for the installed-CLI row:
- Runtime `Object.keys(ctx)` = `[app, location, options, agent, aisdk, catalog, command, event,
  experimental, generate, integration, mcp, permission, plugin, reference, rpc, skill, storage,
  tool, vcs, websearch, worktree, session, shell]` — there is **no `provider`**, **no `model`**,
  **no `credential`**; there **is `catalog`**.
- `ctx.catalog` = `{ provider: {list, get}, model: {list, default}, transform(fn, arity 1),
  reload }`. The transform callback gets a `CatalogEditor`
  (`provider.{list,get,update,remove}`, `model.{get,update,remove,default}`) — **no `add`**, so
  `update` is the upsert.
- Every built-in provider's `package` **starts with `aisdk:`** (`packagePrefixes` = `["aisdk:"]`;
  native `@opencode/ai/*` count was 0).
- `npm view @opencode/plugin dist-tags` → `latest: 2.0.31`, `beta: 0.0.0-beta-19507`. Installed
  plugin/ai/schema/client are all `0.0.0-beta-19507`. (`0.0.0-beta-19242` of `@opencode/plugin`
  does not exist on npm; 19507 is the closest and works.)

### Runtime hook surface (discovered this session — richer than earlier docs knew)

From `@opencode/plugin@beta-19507` type files + empirical probing:

- `ctx.session.hook(kind, cb, {providerID}?)` supports kinds:
  `prompt`, `context`, `compaction`, `generate`, `title`, **`model.request`**,
  **`http.request`**, **`http.response`**, **`retry`**.
  - `context`/`generate`/`title`/`compaction` events carry mutable
    `system: SystemPart[]` (`{type:"text", text, cache?, metadata?}`).
  - `model.request` event: `{sessionID, agent, model: Model.Ref, kind, baseURL?, headers}`
    — **mutable `headers`** (this is how we force Factory's wire headers) and fires for
    **title and primary** requests.
  - `http.request` event: `{…, kind, request: Request}` — fires for **every** provider HTTP
    request (title included) on this CLI build; `event.request` is assignable (TS `readonly`
    is compile-time only), so bodies can be rebuilt. This is the reliable WAF-identity path.
  - **Gotcha (verified on 19242):** the `title`/`compaction` *session* hook kinds do **not**
    fire for title-generation requests, even though `model.request`/`http.request` with
    `kind: "title"` do fire. Don't rely on session hooks alone for the identity gate.
- `ctx.aisdk.hook` exists with kinds `sdk` and `language`; the `language` hook can set
  `language: LanguageModelV3` — a fallback for full custom-model control if ever needed.
  Not used today.
- `Model.Info.default(providerID, id)` seeds `capabilities: {tools:true, input:["text","image"],
  output:["text"]}`, 200k/32k limits, `status:"active"`, `enabled:true`.
- `Model.Ref` = `{id, providerID, variant?}`.

## 4. What already works / is verified

- **Plugin load path**: auto-discovery from `.opencode/plugins/factory.ts` (a one-line shim
  re-exporting `../../src/index.ts`). The `plugins` entry in `opencode.jsonc` pointing at the
  package directory did **not** load earlier; keep the shim.
- **Provider + model registration** via `ctx.catalog.transform` + `editor.provider.update`/
  `editor.model.update` (mutation-upsert; `Object.assign` onto the record the editor passes).
- **Model resolution + compile + streaming** on all three AI-SDK packages (see §2).
- **Agentic tool loop** through Factory (shell-tool round-trip verified).
- **WAF identity gate** satisfied on main **and** title requests — see §5 for the two-layer
  hook design. Verified on the wire via a local capture proxy: `/messages` (system text
  blocks), `/chat/completions` (first system message), `/responses` (top-level `instructions`)
  all carry the identity at offset 0; all responses 200.
- **Wire headers** verified via capture: `authorization: Bearer`, `x-factory-client: cli`,
  `x-client-version: 0.243.0`, per-model `x-api-provider` (`anthropic`/`fireworks`/…) all
  reach the wire. `@ai-sdk/anthropic` additionally sends `x-api-key` (the Factory key);
  Factory tolerates it as long as `authorization` is also present.
- **Fail-fast on missing `FACTORY_API_KEY`** (see §1).
- **`FACTORY_API_BASE_URL`** env override works (used to route through the capture proxy).
- **Org policy filtering** — verified live: policy fetched (`allowAll:false`, 28 allowed/16
  blocked), catalog filtered to 21 models (6/10/5), zero policy-violating models registered, and
  every registered model carries `limit.context`. Cache fallback verified by rerunning with a dead
  `FACTORY_APP_BASE_URL` (same 21 models from `ctx.storage`).
- **Cost + limit metadata** — all 44 models carry generated `cost[]` and `limit` on the live
  catalog (spot-checked `gpt-6-luna` = `{context:1050000, output:128000, input:922000}`,
  `claude-haiku-5-5` = `{context:1000000, output:128000}`).

## 5. Current file contents (state at handoff)

Repo: `/Users/saboya/projects/saboya/opencode-droid`

- `package.json` — name `opencode-factory-plugin`; `exports: {".": "./src/index.ts"}`;
  dep `"@opencode/plugin": "0.0.0-beta-19507"` (exact pin; caret resolves to the reserved
  placeholder); scripts: `typecheck`, `test`, `probe`, `gen-models`.
- `opencode.jsonc` — `{ "$schema", "plugins": ["file:///…/opencode-droid"] }` (inert; the
  `.opencode/plugins/factory.ts` shim is what loads — harmless, kept).
- `src/catalog.ts` — pure data (no `@opencode/plugin` import; loadable by `node scripts/probe.ts`).
  `DROID_IDENTITY`, `CLIENT_VERSION = "0.243.0"`, `FAMILY_PROVIDER` + `providerFor()`, `ROUTES`
  (3 routes, 44 models), `PROBE_CHEAP`, `routeID()`. **Packages are now AI-SDK**:
  - `factory`    (Anthropic Messages, `/api/llm/a/v1`)      → `aisdk:@ai-sdk/anthropic`
  - `factory-o`  (chat completions,   `/api/llm/o/v1`)      → `aisdk:@ai-sdk/openai-compatible`
  - `factory-gpt`(Responses,          `/api/llm/o/v1`)      → `aisdk:@ai-sdk/openai`
  `FactoryModel.limit` is an escape-hatch override only; normally omitted (generated limits apply).
- `src/index.ts` — clean, no debug code. `requireKey()`/`baseURL()` (fail-fast),
  `toModel()`/`toProvider()` (settings: `{baseURL, apiKey}`; headers: bearer + UA + factory
  client headers; per-model `headers: {"x-api-provider": …}`; per-model `cost` from
  `COSTS` and `limit` from `LIMITS`), loads the org model policy (src/policy.ts) and
  **filters the catalog to it** (removing disallowed models), registers routes via
  `ctx.catalog.transform`, then `registerFactoryHooks`, returns a disposer that disposes
  registrations in reverse. Exports nothing else.
- `src/models.gen.ts` — **GENERATED** by `scripts/gen-models.mjs` (models.dev vendor data):
  `COSTS` (USD/Mtok, incl. tiered `cost[]` entries) and `LIMITS` (`{context, input?, output}`
  from upstream vendor windows). Do not edit by hand; regenerate:
  `node scripts/gen-models.mjs [models.dev api.json]`. Caveats + provenance in the file
  header and docs/factory-droid-behavior.md §11 ("Cost & limit metadata").
- `src/multipliers.ts` — Factory usage multipliers in `Model.Info.name` (e.g. `Claude
  Opus 5.5 (1.6×)`). Fetches Factory's public Markdown catalog at setup, in parallel
  with policy loading; cache (`factory/model-multipliers`) + SDK-verified snapshot
  fallback. Promotion expiry handled even offline. Unknown rates omitted. No Droid
  executable/runtime dependency; USD cost data and wire IDs are separate.
- `test/multipliers.test.ts` — catalog parsing, cache/fallback, invalid data,
  changed rates, and promotion-expiry checks (`npm test`).
- `src/policy.ts` — org model policy: `loadModelPolicy()` fetches
  `GET https://app.factory.ai/api/organization/managed-settings`, parses
  `settings.modelPolicy` (`allowAllFactoryModels`, `allowedModelIds`, `blockedModelIds`),
  caches to `ctx.storage` (`factory/model-policy`), and `modelAllowed()` applies
  blocked-then-allowlist. Failure policy: cached policy → else **fail open** (full catalog).
  No `@opencode/plugin` import (store injected). `FACTORY_APP_BASE_URL` overrides the app base.
- `src/hooks.ts` — `registerFactoryHooks(ctx, providerIDs, {key, providerForModel})` registers
  three hook layers per providerID (all scoped by `{providerID}`):
  1. identity prepender for `context`/`generate`/`title`/`compaction` session kinds;
  2. `model.request` → force `authorization`, `x-factory-client`, `x-client-version`,
     per-model `x-api-provider` (via a prebuilt `Map` from the catalog);
  3. `http.request` → **body rewrite fallback**: parses the JSON body and prepends
     `DROID_IDENTITY` to the protocol's gated field (`system` / first system `messages[]`
     entry / `instructions`), idempotently. This is what actually fixes title-generation
     403s on CLI 19242 (see §3 gotcha).
- `.opencode/plugins/factory.ts` — the loader shim (`export { default } from "../../src/index.ts";`).
- `scripts/probe.ts` — standalone M0 HTTP probe against Factory (git-ignored output).
- `scripts/gen-models.mjs` — regenerates `src/models.gen.ts` (costs + limits) from models.dev (see §10).
- `.gitignore` — ignores `node_modules/`, `notes/*.json`, `*.log`.

## 6. Open questions / resolved decisions

- **§6.1 (chat vs responses for `@ai-sdk/openai`) — RESOLVED**: no per-model `package`/
  `settings` distinction exists in the built-in catalog (dumped and compared `gpt-5.4`,
  `gpt-4o`, `gpt-4.1` — all identical). The bundled `@ai-sdk/openai` selects the Responses
  API **by model ID pattern**. Verified on the wire: `factory-gpt/gpt-6-luna` hits
  `/api/llm/o/v1/responses`. No extra settings needed.
- **§6.2/§6.3 (auth/header compatibility) — RESOLVED**: provider `settings.apiKey` is honored
  (the anthropic SDK authenticates with it); provider `headers` pass through; and the
  `model.request` hook can force/override headers unconditionally. Belt-and-braces kept.
- **§6.4 (WAF behaviors under AI-SDK) — RESOLVED**: verified on the wire for all three
  protocols, main + title requests (see §4).

## 7. Verified Factory wire facts (hard-won — keep)

**Endpoint**
- LLM traffic base: **`https://prem.factory.ai`** (`app.factory.ai` / `api.factory.ai` → 403).
- Paths: `/api/llm/a/v1/messages` (Anthropic), `/api/llm/o/v1/chat/completions` (chat),
  `/api/llm/o/v1/responses` (Responses). Also `…/embeddings`, `…/images/*`.
- Env overrides honored: `FACTORY_API_BASE_URL` (and `_EU`), `FACTORY_APP_BASE_URL`,
  `FACTORY_EXTRA_CA_CERTS`, `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`.

**The WAF gate (403 "Forbidden")**
- Factory's premium proxy rejects any request whose **system prompt does not start with exactly**
  ```
  You are Droid, an AI software engineering agent built by Factory.
  ```
  Case/punctuation-sensitive, must be at offset 0. Anything after it is free. Missing → `403
  {"detail":"Forbidden","status":403,"requestId":...}`.
- Per-route identity field: Anthropic → top-level `system`; chat → first `messages[]` role
  `system` (string); Responses → top-level **`instructions`** (NOT `input`; any `input` entry
  with role developer/system/user — string or array — 403s).
- **Factory gates *every* LLM call**, including OpenCode's title generation — those requests
  must carry the identity too (this bit us; see §5 hooks layer 3).

**Headers (verified from the real CLI, 0.243.0, and re-verified through the plugin)**
- Required-ish: `authorization: Bearer <key>`, `content-type: application/json`,
  `accept: application/json`, `user-agent: factory-cli/0.243.0`, `x-factory-client: cli`,
  `x-client-version: 0.243.0`, and **`x-api-provider: <model>`** (required on the chat/OpenAI
  routes: missing → `400 Missing x-api-provider header`; invalid → `400 Invalid x-api-provider`).
- Not required: `openai-platform`, `x-session-id`, `x-assistant-message-id`, `traceparent`,
  `x-stainless-*`, `x-provider-routing-source`.
- Anthropic route: **bearer only** — `x-api-key` alone → `401 Missing authorization token`
  (but `x-api-key` *alongside* a valid bearer is tolerated — the anthropic SDK sends both).

**Provider routing / `x-api-provider`**
- `provider_routing` maps families to ordered backends. Validated for this account (region
  `fra1`): claude→`anthropic`; gpt→`openai` (also `azure_openai`); gemini→`google`;
  glm→`baseten`; deepseek→`baseten`; kimi→`fireworks`; minimax→`fireworks`.
- Grok is **region-unavailable for this account**: feature-flags `provider_routing` lists the
  only backend as `xai`, which returns `400 Invalid x-api-provider` here, and every other backend
  returns `400 Provider not available in this region`. Not fixable by remapping; the two grok models
  stay registered (they may work in other regions) — see §10.
- The server resolves routing per account/region, so a single hardcoded `x-api-provider` cannot
  be universally correct — rotation is deferred.

**Model availability (org policy — enforced per request)**
- The gateway enforces the org's model policy on **every** LLM call. A model that is blocked or
  absent from the allowlist returns
  `403 {"detail":"This model is not available due to your organization's security settings",…}`
  (distinct from the WAF 403 above).
- The policy is published at **`GET https://app.factory.ai/api/organization/managed-settings`**
  (bearer + the same factory client headers), under `settings.modelPolicy`:
  `{ allowAllFactoryModels: bool, allowedModelIds: string[], blockedModelIds: string[] }`.
- Measured for this account: `allowAllFactoryModels: false`, 28 allowed, 16 blocked ⇒ **21 of the
  44 catalog models are usable** (23 excluded: 4 blocked + 19 off-allowlist; grok-4.7 is allowlisted
  but region-dead). `src/policy.ts` fetches this at setup and filters the catalog to match
  (see §5).

**Errors** are JSON `{detail,status,title,requestId}`.

## 8. How to reproduce / debug (exact commands)

```sh
export PATH="/Users/saboya/.npm-packages/bin:$PATH"
cd /Users/saboya/projects/saboya/opencode-droid

# Control (works): proves the LLM path is healthy
opencode2 run --standalone -m opencode/cat-jam-free "say pong"      # -> pong, exit 0

# Our three routes (all should print pong, exit 0)
opencode2 run --standalone -m factory/claude-haiku-5-5 "say pong"
opencode2 run --standalone -m factory-o/glm-5.3-flash "say pong"
opencode2 run --standalone -m factory-gpt/gpt-6-luna "say pong"

# Agentic tool loop
opencode2 run --standalone -m factory/claude-haiku-5-5 \
  "Run the shell command 'echo agentic-pong' using your shell tool, then tell me its output."

# Full logs; plugin errors appear as "failed to load plugin" WARN with the thrown cause
opencode2 run --standalone --print-logs --log-level debug -m factory/claude-haiku-5-5 "say pong"

# Model list (against the background service; standalone prints nothing useful)
opencode2 models | grep factory
```

**Fresh-plugin-code gotcha:** commands *without* `--standalone` talk to the background
service, which keeps whatever plugin version it loaded when it started — after editing
`src/`, `opencode2 models` can show **stale** results (it listed pre-change models
while the on-disk plugin already differed). Exercise plugin edits via
`run --standalone` (verified reliable); treat background-service output as cached.

**Wire-level debugging** (see exactly what hits Factory): run a capture proxy and point the
plugin at it —

```sh
cd /private/var/folders/71/75c4n_4j5r178d8z695vxr880000gn/T/opencode/factory-inspect
CAPTURE_REAL=https://prem.factory.ai CAPTURE_LOG=capture2.log node capture-status-proxy.mjs &
# in the repo:
export FACTORY_API_BASE_URL="http://127.0.0.1:8787"
opencode2 run --standalone -m factory/claude-haiku-5-5 "say pong"
# then inspect capture2.log: status, headers, first 6KB of each body + response prefix
```

Note: `capture-proxy.mjs` logs requests only; `capture-status-proxy.mjs` (added this session)
also logs `status` and a response prefix — prefer it. Ports: 8787 = capture, 8788 = mitm.

**Debugging technique that worked:** `console.error` from inside the plugin is **not reliably
forwarded** to `--print-logs`. Write diagnostics to a file from inside the plugin with
`appendFileSync`/`writeFileSync` (Bun runtime has `node:fs`), e.g. under the approved temp dir
`/private/var/folders/71/75c4n_4j5r178d8z695vxr880000gn/T/opencode/`. Remove before committing.

Plugin setup errors also surface in the user's **TUI** as "Server plugin error" with a stack.

**Useful paths**
- Temp scratch (approved): `/private/var/folders/71/75c4n_4j5r178d8z695vxr880000gn/T/opencode/`
  - `ctx-shape.json` — catalog-shape dump (openai provider/model records).
  - `hooks-fire.log` — hook-firing trace that proved the title-hook gap.
  - `oc-run1.log` … `oc-run10.log` — run logs (`oc-run8.log` has the old schema-validation
    stack; `oc-run10.log` has a ConnectionRefused from a dead proxy — ignore).
  - `factory-inspect/` — capture toolkit + captured wire bodies + `routing.json`:
    `capture-proxy.mjs`, `capture-status-proxy.mjs` (**use this one**), `mitm-proxy.mjs` (:8788),
    `body-*.json`, `routing.json`, `waf-probe.mjs`, `prefix-probe.mjs`, `responses-probe.mjs`,
    `probe-provider.mjs`, `probe-family.mjs`, `probe-grok.mjs`, CA certs.
- Installed packages to read (all `0.0.0-beta-19507`):
  - `node_modules/@opencode/plugin/dist/promise/{plugin,catalog,registration,session,aisdk}.d.ts`
    — the authoritative hook/event shapes (`SessionHooks`, `AISDKHooks`, `CatalogEditor`).
  - `node_modules/@opencode/schema/dist/{model,provider}.d.ts`.
  - `node_modules/@opencode/ai/dist/` — native route system; the beta does **not** use it for
    providers, but `SystemPart`/`Message` types come from here.
- CLI binary: `/Users/saboya/.npm-packages/lib/node_modules/@opencode-ai/cli/bin/opencode2.exe`
  (183 MB Bun-compiled; **do not** `strings`/`grep` it — it embeds the TS compiler and the
  commands time out / print useless huge lines). The CLI has **no** readable JS to inspect.

## 9. Key schema facts

`Provider.Info` (required): `id`, `name`, `activation: "auto"|"enabled"|"disabled"`, `package`;
optional `canonical`, `integrationID`, `settings`, `headers`, `body`, `compaction`, `websocket`.
`Provider.Info.empty(id)` seeds a valid record. `settings`/`headers`/`body` are free-form
records (`$Record<String, Any>` / `$Record<String, String>`).

`Model.Info`: `capabilities` (`{tools, input[], output[]}`), `variants[]`, `time.released`,
`cost[]`, `status`, `enabled`, `limit` (`{context, input?, output}`), `settings?`, `headers?`,
`body?`, `id`, `modelID`, `providerID`, `family?`, `compatibility?`, **`package?`**,
`compaction?`, `websocket?`. `Model.Info.default(providerID, id)` returns a valid baseline.

`CatalogEditor` (beta): `provider.{list,get,update(id,fn),remove(id)}`,
`model.{get,update(p,m,fn),remove(p,m),default.{get,set}}`. `update` **upserts** (verified: a
non-existent provider + models appear after `update`; mutate the passed record with
`Object.assign`).

**Transform flush timing (discovered during cost work):** `await ctx.catalog.transform(fn)`
resolves with a `Registration` **before `fn` executes** — callbacks flush later (after
`setup()` returns; observed `fn` not yet run 1.5s after the await). Consequences:
(1) reading the catalog back immediately after an awaited transform shows **stale**
state; (2) file-write probes must write **from inside the callback**, not after the
await; (3) multiple transforms queue in order, so a second transform does see the
first one's writes when it eventually runs.

## 10. Roadmap / deferred

- **M1 (live test) — ✅ DONE this session** (see §2/§4).
- **Identity hook coverage — ✅ DONE** (two-layer: session hooks + `http.request` body
  rewrite; title/main verified 200 on the wire). Compaction not yet *observed* live (no
  session long enough to trigger it) but the same `http.request` rewrite covers it.
- **M2:**
  - ✅ **Org policy filtering — DONE**: `src/policy.ts` fetches `managed-settings` at setup,
    filters the catalog (blocked + allowlist), caches to `ctx.storage`, falls back to cache then
    fails open. Verified live: 21/44 registered (6/10/5), zero policy-violating models; cache
    fallback verified with a dead app base.
  - ✅ **Context/output limits — DONE**: `src/models.gen.ts` `LIMITS` (from models.dev upstream
    vendor windows) wired in `toModel()`; all 44 generated; catalog override removed (now
    escape-hatch only).
  - **Remaining:** `retry` hook (map 402/429, `Retry-After`) — `ctx.session.hook("retry", …)`
    exposes mutable `decision {retry, delay}` but `SessionError.Error` is only `{type, message,
    status}` (no `Retry-After` field); runtime already retries by default. `/api/feature-flags`
    routing for per-account `x-api-provider` rotation; catalog polish (families, fast-mode
    variants); README; npm naming/publish.
- **M3+**: live catalog refresh from the `droid` binary; `/connect` integration;
  provider rotation on failure; Grok (needs region resolution).
- **Deferred**: OAuth/CLI-credential path, Devin port.
- **Policy facts (this account):** `managed-settings.modelPolicy` has `allowAllFactoryModels:false`
  and `isFastModelsAllowed:false`; 28 allowed / 16 blocked ⇒ 21 of 44 usable. The plugin now
  filters by policy automatically (`src/policy.ts`). Grok stays registered but is region-dead here
  (see §7) — decide later whether to drop it.
- **Consider**: drop the `plugins` entry from `opencode.jsonc` (it appears inert) or verify it
  now loads; the shim works regardless.

## 11. Housekeeping

- Debug probes **removed** — `src/index.ts` and `src/hooks.ts` are clean (verified this
  session). Keep it that way; the file-write debug technique is documented in §8.
- `registerFactoryHooks` **is** called in `setup()`; disposers run in reverse order on
  cleanup.
- `.opencode/plugins/factory.ts` is the canonical loader; keep it.
- `scripts/probe.ts` and `notes/*.json` are git-ignored; safe to delete if they get in the way.
- The `capture-status-proxy.mjs` in temp is not committed anywhere — if wire debugging is
  needed again, it's recreated per §8.
