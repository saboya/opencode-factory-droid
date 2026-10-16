# Reverse-Engineering Playbook — Turning a Proprietary Agent's Gateway into an OpenCode Provider

_Methodology for replicating what `opencode-factory` does, but for **another** provider
(e.g. Devin, Cursor, Amp, Codex CLI, …). Written so an agent can execute it cold. Each
section states the goal, the concrete technique, and the pitfalls actually hit while
building this repo. Examples reference the Factory investigation; substitute the target
provider's names._

_Working assumption: you own a legitimate subscription/API key for the target product
and are reverse-engineering **its client and API contract** to reuse your own
subscription. See §9 (hygiene)._

---

## 0. Strategy overview

The target knowledge is always the same five things:

1. **Endpoints** — where LLM traffic actually goes (hosts/paths/protocols).
2. **Auth** — which headers carry credentials, in what format.
3. **Request contract** — required body fields, identity/system-prompt gates, routing
   headers, per-model quirks.
4. **Catalog** — which models exist, their IDs, families, capabilities, limits.
5. **Client behavior** — what the official client does differently from a naive
   SDK call (telemetry headers, forced system-prompt prefixes, version pins).

Attack order that worked (cheapest/most-discriminating first):

```
recon (npm/GitHub/SDK)  →  static string extraction from binary  →
MITM the real client     →  direct probe scripts against the API  →
build plugin             →  capture-proxy verification loop
```

Each stage feeds the next: static extraction tells you which env vars let you redirect
traffic (skipping MITM); MITM shows you the one "impossible to guess" fact (here: the
Droid identity prefix); probes turn observations into a precise contract.

---

## 1. Recon — find the artifacts before touching the binary

### 1.1 npm is usually the distribution channel

Agent CLIs are almost always published to npm with a platform-binary split:

```
<cli>                     # tiny meta-package: install.js, optionalDependencies
<cli>-darwin-arm64        # 100+ MB tarball containing the real binary
<cli>-linux-x64 …         # same per platform
<cli>-sdk / @scope/sdk    # JS SDK — READABLE source, often with source maps
```

Techniques:

- `npm view <name> dist-tags versions --json` — version history tells you how fast the
  contract churns (pick a pinned version to impersonate).
- The meta-package's `optionalDependencies` reveals **every** platform package name —
  fetch the exact one with `npm pack @scope/<cli>-darwin-arm64@<ver>` or direct
  registry download. No need to run (or trust) their installer.
- The `repository` field often points at a (possibly public) GitHub repo —
  `apps/cli` style monorepo paths are a jackpot (real TS source instead of a binary).
- **Always check for an SDK package.** Factory shipped `@factory/droid-sdk` (1.4 MB,
  `dist/*.js` + `.js.map`): readable, bundled-but-parseable JS with source maps. That
  is orders of magnitude cheaper than binary analysis. Grep it first for hosts, paths,
  header names, env vars.

### 1.2 Also collect

- The product's web app / docs (API path names often leak in JS bundles or OpenAPI).
- Prior art: search GitHub for `"<product>" opencode plugin`, `"<product>" proxy`,
  CLI wrappers — but re-verify everything (contracts drift, and prior art often copies
  stale guesses).
- Your own account's state: feature flags, org settings, and routing tables are
  usually fetchable **with your key** via the product's REST API (discovered in §3).

**Deliverable:** a list of candidate hosts, env vars, header names, and package names.

---

## 2. Static extraction from the binary

### 2.1 What NOT to do

Do **not** run `strings` or `grep` over a modern Bun/Deno-compiled CLI binary
(this project's `opencode2.exe` is 183 MB and the Factory `droid` binary ~120 MB):

- They embed a **TypeScript compiler / full runtime**, so `strings` output is
  gigabytes of framework noise; grep matches thousands of irrelevant hits.
- These commands **time out** and any matched line is a 100 KB minified line —
  useless even when it succeeds.
- This restriction is why `extract.mjs` exists (below).

### 2.2 Bounded window extraction (the working technique)

Read the binary as `latin1` (1 byte = 1 char, offsets stay valid), search for your
needle with `indexOf`, and print only a **small printable window** around the first
N matches. ~30 lines:

```js
// extract.mjs <binary> <needle…>
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const text = buf.toString("latin1");
const WIN = 260, MAX_PER = 6;               // hard caps — this is the whole point
const printable = s => s.replace(/[^\x20-\x7e\n\r\t]+/g, " ").replace(/[ \t]{2,}/g, " ");
for (const pat of process.argv.slice(3)) {
  let idx = 0, n = 0;
  while (n++ < MAX_PER && (idx = text.indexOf(pat, idx)) !== -1) {
    console.log(printable(text.slice(Math.max(0, idx - WIN), idx + pat.length + WIN)));
    idx += pat.length;
  }
}
```

Needles that pay off, in order:

1. **Env var names**: `FACTORY_API_`, `BASE_URL`, `HTTPS_PROXY` — every override the
   client honors is leverage for the next stages (redirect traffic without MITM).
2. **Header names**: `x-api-provider`, `x-client-version`, `x-factory-client` —
   immediately suggests the probe matrix in §4.
3. **URL fragments**: `/api/llm/`, `/v1/responses`, `wss://` — the endpoint map.
4. **Literal strings that look enforced**: sentence-shaped constants near
   `system`/`prompt` keys (this is how the Droid identity *prefix hypothesis*
   originated before probes proved it).
5. **Model IDs / enum members**: cross-check against the live catalog.

Findings are **hypotheses**, not facts — a string in the binary may be dead code.
Promote each to verified only via §3/§4.

### 2.3 Don't decompile unless you must

Bytecode decompilers for Bun executables are lossy and slow. The combination of
§2.2 + §3 recovers the full external contract without ever understanding the
internals. Reserve disassembly for one question only: "what does this one call
actually send?" — and even then, MITM answers it faster.

---

## 3. Dynamic A — watch the official client talk

### 3.1 Find the redirect lever first

Before building a TLS MITM, check §2.2 findings: if the client honors
`HTTPS_PROXY` / `HTTP_PROXY` / a base-URL env var / a config file, use it. Two
distinct tools fall out of this:

### 3.2 Plain capture proxy (no TLS interception) — **preferred when possible**

A ~60-line Node HTTP proxy that forwards to the real HTTPS origin and logs
status + headers + body prefix:

```js
// capture-status-proxy.mjs — log method/path/status/headers/body-prefix, retransmit
import http from "node:http";
import { request as httpsRequest } from "node:https";
const server = http.createServer((req, res) => {
  /* concat body → httpsRequest(new URL(req.url, REAL_ORIGIN), …) →
     log {method, path, status, redacted headers, body.slice(0, 6KB), resp.slice(0, 500)}
     → pipe response back untouched */
});
```

Key details that matter:

- Point the **client** at it via `FACTORY_API_BASE_URL=http://127.0.0.1:8787`
  (works because the gateway serves all routes under the same origin).
- Log the **response status + a response prefix** too, not just requests — a 200 with
  the right body is your only real success signal, and error bodies explain 400/403s.
- **Redact** `authorization`/`api-key`/`cookie`/`token` headers in the log file
  (replace with `<length>B`) — captures end up in temp dirs for days.
- This same proxy doubles as the **verification loop for your own plugin** (§7).

### 3.3 TLS MITM (CONNECT interception) — when there's no override

Needed when the client hardcodes its hosts. Setup used here (~90 lines,
`mitm-proxy.mjs`):

1. **Local CA**: `openssl req -x509 -newkey rsa:2048` → `ca.key`/`ca.pem`, with a
   `san.cnf` covering the target wildcard (`DNS:*.factory.ai`, plus auth-provider
   hosts like `*.workos.com` — remember login/telemetry hosts, not just the API host).
   Then a leaf cert signed by that CA (`leaf.pem`/`leaf.key`).
2. **HTTP `CONNECT` server**: on `CONNECT host:443`, answer `200` **without**
   connecting yet; wrap the socket in `tls.createServer` presenting the leaf cert;
   run a plain HTTP server on that socket to read the decrypted request; forward it
   to the real origin over real TLS; log both directions. Tunnel every non-target
   host untouched (`net.connect` splice).
3. **Client side**: `export HTTPS_PROXY=http://127.0.0.1:8788` (honored only because
   §2.2 found the env var) **or** `NODE_EXTRA_CA_CERTS=ca.pem` / the product's own
   `*_EXTRA_CA_CERTS` var if the client verifies the CA. Our target did **not** do
   certificate pinning — test yours early (a pin manifests as an immediate TLS error).
4. **Decode responses**: compressed bodies need `gunzipSync`/`brotliDecompressSync`
   keyed off `content-encoding` from the response-head log entry (see `decode.mjs`).

What the MITM bought us in one real session: the complete non-LLM API surface
(`/api/feature-flags`, `/api/organization/managed-settings`, `/api/cli/whoami`,
`/api/billing/limits`, cloud-sync telemetry), the exact header set the real CLI sends,
the routing table JSON, and the fact that **every** request — including background
title generation — carries a system prompt that must start with a specific sentence.
None of that was guessable.

### 3.4 Run the real client, not just the API

The point of §3 is **behavior**, so exercise the features you care about: one chat
turn, a title rename (usually auto-triggered), a session compaction, logout/login.
Background requests (title gen, feature flags, telemetry) only appear when the client
actually runs.

---

## 4. Dynamic B — derive the contract with probe scripts

MITM shows **one** observed truth; probes map the **boundary** (what's required vs
tolerated). Write tiny `fetch` scripts — one variable changed per case, status-code
printed per case. Patterns that worked:

### 4.1 Minimal bodies, minimal tokens

```js
{ model: "glm-5.3-flash", max_tokens: 16,
  messages: [{role:"system",content:SYS}, {role:"user",content:"ping"}] }
```

Cheap model + `max_tokens: 16` keeps quota burn negligible across hundreds of probes.
Pick a `PROBE_CHEAP` model per route and reuse it.

### 4.2 Case-table probing (binary-search the contract)

For the WAF gate we ran one script over a **table of string variants**, printing
`200 ✓`/`403` per row: exact, no-period, trailing-space, leading-newline, lowercase,
prefix-only, prefix+extra-text, extra-text-only… Then repeated per protocol route
(chat / anthropic / responses) because **each protocol gates a different body field** —
never assume one route's answer generalizes to another. (`waf-probe.mjs`,
`prefix-probe.mjs`.)

Generalize: for any "the server rejects my request" mystery, vary **one dimension at
a time** in a table: presence/absence, exact value, position in body, header vs body,
per route, per model.

### 4.3 Matrix probing for routing/enum values

When an error says `Invalid <header>` (e.g. `x-api-provider`), probe
`candidate values × models` and record status + error text:

```js
for (const [model, providers] of tests)
  for (const p of providers) console.log(status, model, `<-`, p, note);
```

The **error-message taxonomy** is itself documentation:
`400 Missing x` vs `400 Invalid x` vs `400 Provider not available in this region`
distinguished "unset" from "wrong value" from "right value, wrong region" — worth
logging verbatim in your notes.

### 4.4 Status-code taxonomy

Record what each status means for your target and encode it in your plugin's retry
policy (402 quota, 429 rate + `Retry-After`, 403 contract-gate, 400 contract typo,
401 auth). In this project 403 **never** meant "forbidden subscription" — it meant
"identity gate", a distinction that took the first full day to establish.

---

## 5. OpenCode plugin side — the undocumented surface

Half of this project's difficulty was OpenCode-side, not Factory-side. Hard facts,
all verified against the **installed beta CLI**, not the docs:

### 5.1 Two incompatible plugin API lineages exist

| | installed CLI (target here) | opencode.ai/v2 docs lineage |
|---|---|---|
| CLI | `@opencode-ai/cli 0.0.0-beta-19242` (`opencode2`) | `2.x` |
| add provider | `ctx.catalog.transform(e => e.provider.update(id, fn))` (**upsert**) | `ctx.provider.transform(e => e.add({info, models}))` |
| provider `package` | **`aisdk:@ai-sdk/<pkg>`** | **`@opencode/ai/providers/<pkg>`** |
| plugin package | `@opencode/plugin@0.0.0-beta-*` | `@opencode/plugin@2.x` |

**Diagnose which lineage you're on before writing code**, in this order:

1. `npm view @opencode/plugin dist-tags` vs what your CLI's `node_modules` has.
2. Runtime dump of `Object.keys(ctx)` from inside a throwaway plugin (there is
   `catalog` but **no** `provider`/`model`/`credential` on the beta).
3. `packagePrefixes` of the built-in catalog (all `aisdk:` on the beta — zero native).
4. The schema error itself: `InvalidType expected "LLM.LanguageModel"` on `model`
   means you used the docs' `package` format with the beta CLI. That single error
   cost the previous session the whole day; it's a **lineage mismatch**, not a typo.

### 5.2 Where the authoritative types live

Forget the website. Read the **installed** package:

```
node_modules/@opencode/plugin/dist/promise/{plugin,catalog,registration,session,aisdk}.d.ts
node_modules/@opencode/schema/dist/{model,provider}.d.ts
node_modules/@opencode/ai/dist/          # SystemPart/Message types (native route system, unused by beta for providers)
```

`SessionHooks` / `AISDKHooks` / `CatalogEditor` there are the contract. The published
plugin package version need not match the CLI exactly (19507 plugin types ran fine
against 19242 CLI); pick the closest beta.

### 5.3 Hook kinds the docs don't mention

`ctx.session.hook(kind, cb, {providerID}?)` on the beta accepts, beyond the documented
`prompt/context/generate/title/compaction`:

- **`model.request`** — event `{sessionID, agent, model, kind, baseURL?, headers}`;
  **`headers` is mutable**. This is the reliable way to force wire headers, and it
  fires for `kind:"title"` requests too.
- **`http.request`** — event carries `request: Request`; TS marks it `readonly` but
  that's **compile-time only**: assign a rebuilt `Request` and the runtime honors it.
  This is the only hook guaranteed to fire for *every* provider HTTP call (title,
  compaction, main) and therefore the right place for body-contract enforcement
  (identity injection).
- **`http.response`**, **`retry`** (mutable `decision {retry, delay}` — for
  402/429/`Retry-After` policies).
- `ctx.aisdk.hook` has `sdk` and `language` kinds; `language` can inject a fully
  custom `LanguageModelV3` — a nuclear fallback if a provider's protocol can't be
  expressed with stock AI-SDK packages.

**Gotcha discovered by experiment (write yours down the same way):** the `title` /
`compaction` *session* hook kinds did **not** fire on CLI 19242 for title-generation
requests, while `model.request`/`http.request` with `kind:"title"` did. Proven by
writing hook-fire traces to a file (§6), not by reading docs (docs don't cover it).
Lesson: **instrument which hooks actually fire** before building on them.

### 5.4 Registration mechanics (beta)

- `ctx.catalog.transform(fn)` gives a `CatalogEditor`:
  `provider.{list,get,update(id,fn),remove}` / `model.{get,update(p,m,fn),remove,default}`.
  There is **no `add`** — `update` upserts; mutate the passed record with
  `Object.assign`. Non-existent provider + models appear after one transform.
  **Gotcha (measured):** `await transform(fn)` resolves *before* `fn` runs — callbacks
  flush after `setup()` returns. So a read-back right after the await shows stale
  state, and file-write probes must write **from inside the callback**. Queueing
  multiple transforms is fine; they apply in order.
- Seed records instead of hand-building: `Provider.Info.empty(id)` and
  `Model.Info.default(providerID, id)` return valid baseline objects (capabilities
  `{tools, input, output}`, limits, `status`, `enabled`).
- Provider `settings.apiKey` **is** honored by the AI-SDK layer; provider `headers`
  pass through; and `model.request` can override both — keep all three (belt and
  braces) until a capture proves one suffices.
- Model-vs-provider package choice: `Model.Info` also has a `package?` field if a
  single provider needs mixed protocols (we split into three providers instead).

### 5.5 Loading & debugging mechanics

- **Auto-discovery**: `.opencode/plugins/<name>.ts` in the project is what actually
  loads (one-line shim re-exporting `src/index.ts`). A `plugins: ["file://…"]` entry
  in `opencode.jsonc` pointing at a package directory was **inert** — keep the shim
  regardless of config.
- **Plugin errors**: a throw in `setup()` surfaces as `failed to load plugin` WARN in
  logs (and "Server plugin error" in the TUI) with your message — so fail-fast auth
  checks work, but…
- **`console.error` from inside the plugin is NOT reliably forwarded** to
  `--print-logs`. The working technique: write diagnostics to a file with
  `appendFileSync`/`writeFileSync` (Bun runtime has `node:fs`) under the approved temp
  dir. Use it to trace hook firing, `ctx` shape, catalog contents — then **delete
  every probe before finishing** (check `src/` is clean as a completion gate).
- CLI binary: there is **no readable JS** in a Bun-compiled CLI; go through §2.2, and
  prefer running it under §3's proxies over any binary introspection.

---

## 6. Catalog & config discovery (provider-specific)

To build the model list and per-model settings:

1. **Feature flags / catalog endpoints**: after §3, look for a
   `/feature-flags`, `/models`, `/catalog` response — Factory's carried the whole
   `provider_routing` table (model → ordered backends) which seeded `x-api-provider`
   values; the remaining gaps were closed by §4.3 probing.
2. **Org/plan policy**: fetch `managed-settings`-equivalent endpoints with your key;
   blocked models (fast variants, org-disabled) show up here, not in the catalog.
   Registering them without filtering yields models that 403/400 at use time. **Apply
   the filter at registration**: fetch the policy once during `setup()`, keep only
   `allowedModelIds` minus `blockedModelIds` (when `allowAll*` is false), and cache it
   (e.g. `ctx.storage`) so a transient fetch failure falls back to the last known
   policy; if there is no cache at all, **fail open** (register everything) — showing a
   few unusable models beats hiding working ones. Verify by dumping the live registered
   set and asserting it contains no policy-denied id. Note the policy-denial error is a
   *different* 403 from the identity/WAF 403 — compare `detail` strings, not just codes.
3. **Protocol split per model family**: observe which body the server accepts
   (anthropic `system` vs chat `messages` vs responses `instructions`) and split
   providers accordingly; map OpenCode provider → AI-SDK package by protocol:
   - Anthropic Messages → `aisdk:@ai-sdk/anthropic`
   - OpenAI Chat → `aisdk:@ai-sdk/openai-compatible` (always chat)
   - OpenAI Responses → `aisdk:@ai-sdk/openai` (picks **Responses vs chat by model-ID
     pattern** — verify which one your gateway wants; no setting switches it)
4. **Context/output limits**: `Model.Info.default` gives 200k/32k placeholders, which
   are wrong for most modern models and directly control **compaction timing** (too
   small ⇒ premature compaction; too large ⇒ context-overflow 400s). Don't hand-tune —
   take `limit` from the same upstream-vendor record as the price (§6.5). The gateway
   proxies to the vendor window, so the vendor value is the correct one. Keep a
   per-model override field in your catalog as an escape hatch, but leave it unset by
   default.
5. **Cost/pricing**: the target gateway usually exposes **no USD prices** when it's
   subscription/quota-billed. Don't guess — pull upstream vendor list prices from the
   **models.dev** dataset (`https://models.dev/api.json`; also cached by OpenCode
   itself at `~/.cache/opencode/models.json`, but it goes stale — fetch fresh). Its
   `cost`/`tiers`/`limit` fields map 1:1 onto `Model.Info` (`limit` is
   `{context, input?, output}`), so one script can emit **both** your cost table and
   your limit table from the same resolved record. Generate a committed
   table with a script that (a) prefers **canonical vendor records over resellers**
   (reseller prices diverge up to 50×), (b) encodes ID aliases explicitly, and
   (c) **aborts on unresolvable models** instead of silently picking a bad source.
   Document that list prices ≠ what the subscription actually charges.
6. Version-pin every impersonated header (`user-agent`, `x-client-version`, …) to the
   CLI version you observed, as one constant (`CLIENT_VERSION`) for a one-line bump.

---

## 7. Build & verification loop (definition of done)

Order of proof — each step isolates a different failure domain:

1. **Control run** with a known-good non-target model
   (`opencode2 run --standalone -m opencode/cat-jam-free "say pong"`) — proves the
   LLM path is healthy before blaming your plugin.
2. **One cheap model per route** (`say pong`, expect exit 0) — proves registration,
   package resolution, auth, and the request contract.
3. **`opencode2 models | grep <provider>`** — proves catalog registration. If you
   filter by org policy, also dump the *live* registered set (a probe that reads back
   the catalog from inside a second `catalog.transform`) and assert it contains no
   denied id and that every model has real cost/limit metadata.
4. **Agentic tool round-trip** (ask it to run a shell command) — proves tool-call
   streaming survives the gateway's transformations.
5. **Wire capture of every request type** through `capture-status-proxy.mjs` —
   prove on the wire: status 200, auth/routing headers present, identity/contract
   field at offset 0, **including background requests** (title generation is the one
   that silently 403s). Trigger edge paths where feasible (compaction: run a long
   session or accept "covered by the same rewrite" as documented residual risk).
6. **Missing-secret fail-fast**: unset the key, expect a clear load error, and
   confirm how it surfaces (WARN vs crash).
7. **Controlled revert**: if a hook layer might be dead, temporarily disable it and
   watch the failure return — that's how we proved which hook layer actually fixed
   the title 403s.

Keep `HANDOFF.md` (or equivalent) updated with: verified facts vs hypotheses, exact
repro commands, file-by-file state, and next steps — the next agent's context starts
where yours ends.

---

## 8. Tooling checklist (recreate in ~30 min if the temp dir is gone)

| Tool | Purpose |
|---|---|
| `extract.mjs` | bounded windowed string search in binaries (§2.2) |
| `capture-status-proxy.mjs` | plain HTTP capture w/ status + body prefixes, redacted headers (§3.2; also the plugin verification loop) |
| `mitm-proxy.mjs` + `ca.pem`/`leaf.pem` | CONNECT TLS interception for clients without override env vars (§3.3) |
| `decode.mjs` | gunzip/brotli-decode captured response bodies (§3.3) |
| `waf-probe.mjs` / `prefix-probe.mjs` | case-table contract probing (§4.2) |
| `probe-provider.mjs` | enum/routing matrix probing (§4.3) |
| hook-fire file trace | which hook kinds actually fire on your CLI build (§5.3) |

Scratch space: keep everything under the harness-approved temp dir (here
`/private/var/folders/…/T/opencode/`), never in the repo; repo gets `docs/` +
`HANDOFF.md` only.

---

## 9. Hygiene, safety, and ethics

- **You're exercising your own paid subscription** — but still probe minimally:
  `max_tokens ≤ 32`, cheap models, retry storms avoided (they also pollute the
  rate-limit signal you're trying to measure).
- **Redact secrets at write time** in every log; captures live for days.
- Don't commit captures, keys, CA private keys, or probe scripts; the CA key exists
  only in temp and only for the session. Keep `.gitignore` covering `*.log`,
  `notes/*.json`, `*.env`.
- Respect ToS: the goal is reusing *your own* subscription inside *your own* tooling
  (reverse-engineering interoperability), not redistribution of their gateway or
  credential sharing. Before **publishing** anything derived (npm package, docs),
  re-read the provider's ToS and consider whether identifiers like their enforced
  system-prompt sentence belong in a public repo at all.
- Impersonating their client means your plugin can break silently when they bump
  versions — pin the version constant, re-run §7's loop on updates, and prefer
  failing loudly (fail-fast setup) over silently sending malformed requests.
- Remove all debug instrumentation before declaring done; the file-write debug
  technique (§5.5) is easy to forget and it writes to disk on every request.
