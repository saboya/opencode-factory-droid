# Agent guide

## Purpose and scope

This is a small TypeScript ESM **OpenCode V2 plugin**, published as
`opencode-factory-plugin`. It exposes Factory (Droid) subscription models as
providers inside **OpenCode's own agent/tool loop**. It does not delegate work to
the Droid executable. Keep Factory-specific behavior isolated in this plugin.

- Authentication is `FACTORY_API_KEY` from the environment only. Missing or blank
  keys must fail clearly during setup. No `.env` loading, OAuth, or CLI-credential
  discovery is implemented.
- The verified OpenCode CLI and exact `@opencode/plugin` dependency are **2.0.32**;
  Factory client headers currently mirror **0.243.0**.
- Do not add billing/quota investigation, executable dependencies, automatic
  backend rotation, or custom retry behavior as incidental feature work. These
  are outside the current implementation; OpenCode supplies retries.

## Start here and navigate

Read `README.md` for installation, configuration, and current user-facing behavior.
Then follow the relevant implementation and tests:

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entrypoint; auth, provider/model construction, startup fetches, registration, cleanup. |
| `src/catalog.ts` | Three routes, static model inventory, display/wire IDs, backend mappings, identity and client-version constants. Pure data/helpers; no OpenCode runtime imports. |
| `src/hooks.ts` | Provider-scoped identity injection, mandatory headers, GPT stateless reasoning options. |
| `src/policy.ts` | Organization-policy fetch, persistent cache, allow/block filtering. Persistence is injected; no OpenCode runtime import. |
| `src/multipliers.ts` | Public Factory credit rates, validated cache, bundled fallback, promotion expiry, display-name labels. |
| `src/titles.ts` | Free OpenCode title-model selection; explicit title settings take precedence. |
| `src/models.gen.ts` | **Generated** USD prices and context/output limits; never edit manually. |
| `scripts/gen-models.mjs` | Generates metadata from models.dev; canonical-provider preferences and model aliases live here. |
| `test/*.test.ts` | Node test-runner unit tests for registration/policy, GPT hooks, multipliers, titles, and cleanup. |
| `scripts/smoke-opencode.ts` | Real installed CLI against loopback Chat/Responses fixtures, including a reasoning/tool-result round trip and free titles. |
| `scripts/probe.ts` | Optional **live, quota-consuming** HTTP investigation; writes ignored `notes/m0-probe.json`. |
| `docs/factory-droid-behavior.md` | Verified Factory endpoints, wire requirements, policy, regional routing, and errors. |
| `docs/reverse-engineering-playbook.md` | Investigation methodology; consult for gateway-contract research, not routine feature work. |
| `HANDOFF.md` | Investigation history and deferred ideas; contains outdated beta API/version/path guidance. |

**Resolve conflicting documentation against current source, tests, and the pinned
SDK.** In particular, do not copy `ctx.catalog`, beta dependency versions,
`opencode2`, or machine-specific paths from `HANDOFF.md`. Current registration uses
`ctx.provider.transform(editor => editor.add({ info, models }))`. For SDK changes,
inspect the installed public typings and current V2 documentation; do not guess
API shapes or import private SDK internals.

## Development and validation

Use **Node.js 22.18+** and npm. Scripts that directly import TypeScript with `node`
need native TypeScript support. The package exports `src/index.ts` directly; there
is no build step, formatter, or lint script configured.

```sh
npm ci
npm run typecheck
npm test
npm run test:opencode
```

- Typechecking is strict and emits no files. Follow the existing ESM/import style
  and use type-only imports where appropriate. Standalone Node scripts use `.ts`
  import extensions; plugin source uses extensionless local imports.
- `npm test` runs `tsx --test test/*.test.ts`; use `npx tsx --test test/hooks.test.ts`
  (or another test file) for targeted work. Tests use `node:test` and strict Node
  assertions, with mocked contexts/fetch or injected stores. Restore environment
  changes and mocks after tests.
- `test:opencode` requires an installed compatible `opencode` binary; override it
  with `OPENCODE_BIN`. It creates an isolated standalone project/home and uses
  fake credentials and loopback LLM/policy fixtures, **not Factory quota**. It may
  still fetch public multiplier/catalog data; do not assume fully offline execution.
  `OPENCODE_TMP_DIR` controls its scratch-directory parent.
- Run typecheck and unit tests for changes. Also run the CLI smoke for changes to
  registration, transports, request hooks, title selection, or SDK versions. Report
  unavailable CLI/environment prerequisites rather than implying smoke coverage.
- The smoke covers Chat and Responses, not Anthropic. Add targeted tests when
  changing protocol body rewriting, policy/cache failure paths, or other behavior
  not exercised by existing fixtures; do not equate current tests with full wire
  coverage.

## Contracts to preserve

### Three distinct transports

| Provider ID | Package | Base path and endpoint |
| --- | --- | --- |
| `factory` | `aisdk:@ai-sdk/anthropic` | `/api/llm/a/v1/messages` |
| `factory-o` | `aisdk:@ai-sdk/openai-compatible` | `/api/llm/o/v1/chat/completions` |
| `factory-gpt` | `aisdk:@ai-sdk/openai` | `/api/llm/o/v1/responses` |

LLM traffic defaults to `https://prem.factory.ai`; organization settings use
`https://app.factory.ai`. The plugin supports `FACTORY_API_BASE_URL` and
`FACTORY_APP_BASE_URL` separately. Do not assume every environment override
documented for the official Droid CLI is implemented by this plugin. Preserve
the verified `aisdk:` packages unless deliberately migrating and wire-testing.

### Identity, headers, and scope

- Every Factory LLM request, including auxiliary requests, must begin its gated
  system field with the exact `DROID_IDENTITY` constant, at offset zero:
  `You are Droid, an AI software engineering agent built by Factory.`
- Gated fields differ: Anthropic's top-level `system` (string or text blocks),
  Chat's first system message, and Responses' top-level `instructions`. Responses
  `input` is **not** a substitute for `instructions`.
- Keep both session-level prepending and the idempotent `http.request` fallback.
  Auxiliary requests have bypassed semantic hooks on tested CLI builds. Preserve
  existing prompt content and avoid duplicate prefixes or unrelated rewrites.
- Preserve bearer authorization on **all** routes, Factory client/version headers,
  the provider user-agent, and per-model `x-api-provider`. Anthropic's SDK may also
  send `x-api-key`; it does not replace bearer auth.
- Scope Factory hooks by provider ID. Never leak Factory credentials, identity,
  or GPT options into unrelated providers. Backend selection comes from
  `providerFor()` and model overrides, not just the protocol. Organization approval
  does not imply regional backend availability; do not remove models globally
  because one account/region rejects them.

### GPT Zero Data Retention

All `factory-gpt` requests use `store: false` and include
`reasoning.encrypted_content`. Apply these settings **before SDK prompt
conversion**, in provider defaults and semantic hooks, not merely in the HTTP
body. Otherwise the SDK can replace history with unusable `item_reference`s.
Follow-up tool steps must replay encrypted reasoning, function calls, and function
outputs in full. Preserve other `include` options, deduplicate additions, and
leave the other two providers' options unchanged.

### Startup policy, caching, and lifecycle

- Policy and multipliers load once per setup, in parallel. Refresh currently
  requires plugin/service reload; do not imply per-request/live refresh.
- Policy comes from `/api/organization/managed-settings`. Blocked models win over
  an allowlist or `allowAll`; with `allowAll: false`, only allowlisted models are
  registered. Filter before publishing; omit routes with no allowed models.
- Preserve policy fallback: fresh policy → last-known `factory/model-policy`
  cache → **fail open** to the full catalog. The gateway still enforces policy.
  Cache persistence is best effort and must not make setup fail.
- Provider transforms are replayable: publish deterministic source inventories,
  not accumulated mutations. Capture setup data rather than fetching inside a
  replayed transform. Retain registration handles and dispose them in reverse
  order on cleanup.

### Titles and pricing are separate concerns

- Automatic titles default only to enabled, free text models from OpenCode's
  `opencode` provider, using the preference in `src/titles.ts`. Preserve explicit
  `agents.title.model` settings. If no free model exists, skip automatic titles
  rather than silently spending Factory quota. Do not change conversation or
  compaction model selection. This title default is project-wide.
- Factory credit multipliers belong only in model **display names**. Stable
  provider/model IDs and wire IDs must not acquire rate labels. Fetch rates from
  Factory's public Markdown catalog, then use cache/bundled fallback; unknown
  rates get no suffix. Preserve promotion expiry even offline. Never infer rates
  from USD prices or inherit a base multiplier for `-fast` models.
- `COSTS` are upstream USD-per-million-token estimates, **not Factory billing**.
  `LIMITS` are upstream windows used for compaction, not exhaustively verified
  Factory serving limits. Incorrect limits can cause premature compaction or
  context-overflow failures.

## Adding or changing models

1. Edit `src/catalog.ts`: select the correct route, stable ID, optional wire
   `modelID`, family, and backend override. Keep it usable outside OpenCode.
2. Update `PREF`, `ALIAS`, or `PROVIDER_OVERRIDE` in `scripts/gen-models.mjs` if
   needed. Prefer canonical vendor records; generation intentionally fails on
   unresolved metadata rather than silently choosing a reseller. `-fast` models
   inherit base USD metadata/limits, not Factory multipliers.
3. Run `npm run gen-models`, or
   `node scripts/gen-models.mjs /path/to/models-dev-api.json`, and commit the
   regenerated `src/models.gen.ts`. Review provenance, tiers, and limits. Use
   `FactoryModel.limit` only as a documented escape-hatch override.
4. Verify multiplier data independently; update bundled fallback/promotion terms
   only with evidence. Add regression tests and update relevant README/reference
   documentation when user-visible behavior changes.

## Local loading, debugging, and safety

- For local CLI verification, create `.opencode/plugins/factory.ts` re-exporting
  the default from the checkout's `src/index.ts` (see README). Do not assume this
  shim already exists in a fresh clone. Local `opencode.jsonc` is ignored and can
  contain machine-specific paths; do not commit them.
- Git-loaded plugins run from cached checkouts. Background services also retain
  loaded code/environment; prefer `run --standalone` for development or restart
  the service intentionally. A stale model list is not proof an edit failed.
- Live probes spend subscription quota: do not run them as routine tests without
  user authorization. The legacy probe needs an explicit correct gateway, e.g.
  `FACTORY_API_BASE_URL=https://prem.factory.ai npm run probe`; its default host
  candidates are historical investigation targets, not the plugin's default.
- Never commit API keys, `.env` files, captured authorization headers, prompts,
  private account/policy data, or diagnostic dumps. `notes/*.json` and logs are
  ignored; being ignored does not make their contents safe to share. Redact
  captures and remove temporary instrumentation before finishing.
