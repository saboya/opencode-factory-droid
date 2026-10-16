/**
 * M0 probe — validates Factory's three LLM-proxy routes with FACTORY_API_KEY
 * and records the quirks the plugin needs (headers, host, body fixups,
 * identity-sentence requirements, model availability).
 *
 * Usage:  FACTORY_API_KEY=fk-... node scripts/probe.ts [phase]
 * Phases: headers | models | system | reasoning | all (default)
 *
 * Output: notes/m0-probe.json + a console summary.
 * Never prints the API key.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import {
  CLIENT_VERSION,
  PROBE_CHEAP,
  ROUTES,
  routeID,
  type RouteID,
  type RouteSpec,
} from "../src/catalog.ts";

const RAW_KEY = process.env.FACTORY_API_KEY;
if (!RAW_KEY) {
  console.error("FACTORY_API_KEY is not set. Export it first: export FACTORY_API_KEY=fk-...");
  process.exit(1);
}
const KEY: string = RAW_KEY;

const PHASE = process.argv[2] ?? "all";
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 60_000);
const HOSTS = process.env.FACTORY_API_BASE_URL
  ? [process.env.FACTORY_API_BASE_URL]
  : ["https://app.factory.ai", "https://api.factory.ai"];
let host = HOSTS[0];

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  text: string;
  ms: number;
}

function redact(s: string): string {
  return s.split(KEY).join("***KEY***");
}

function snippet(s: string, n = 400): string {
  return redact(s.length > n ? s.slice(0, n) + ` …(${s.length}B)` : s);
}

async function post(path: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { status: res.status, text: await res.text(), ms: Date.now() - started };
  } catch (err) {
    return { status: 0, text: `FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started };
  }
}

function pathFor(route: RouteSpec): string {
  const verb =
    routeID(route) === "anthropic" ? "/messages" : routeID(route) === "chat" ? "/chat/completions" : "/responses";
  return `${route.basePath}${verb}`;
}

function requestBody(route: RouteID, model: string): Record<string, unknown> {
  if (route === "anthropic") return { model, max_tokens: 64, messages: [{ role: "user", content: "ping" }] };
  if (route === "chat") return { model, max_tokens: 64, messages: [{ role: "user", content: "ping" }] };
  return { model, input: "ping", max_output_tokens: 64 };
}

function withSystem(route: RouteID, model: string, system: string): Record<string, unknown> {
  const body = requestBody(route, model);
  if (route === "anthropic") return { ...body, system };
  if (route === "chat") return { ...body, messages: [{ role: "system", content: system }, { role: "user", content: "ping" }] };
  return { ...body, instructions: system };
}

/** Apply route-specific body corrections when the server rejects a 400. */
function fixups(route: RouteID, body: Record<string, unknown>, text: string): { body: Record<string, unknown>; note: string } | undefined {
  if (!/max_completion_tokens/i.test(text)) return undefined;
  if (route !== "chat") return undefined;
  const next = { ...body };
  delete next.max_tokens;
  next.max_completion_tokens = 64;
  return { body: next, note: "max_tokens→max_completion_tokens" };
}

interface Attempt {
  status: number;
  ms: number;
  note?: string;
  snippet?: string;
  xapiRetry?: Attempt;
}

async function sendWithFixups(
  route: RouteID,
  spec: RouteSpec,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Attempt> {
  let res = await post(pathFor(spec), body, headers);
  const notes: string[] = [];
  let current = body;
  for (let i = 0; i < 2 && res.status === 400; i++) {
    const fix = fixups(route, current, res.text);
    if (!fix) break;
    notes.push(fix.note);
    current = fix.body;
    res = await post(pathFor(spec), current, headers);
  }
  const attempt: Attempt = { status: res.status, ms: res.ms };
  if (notes.length) attempt.note = notes.join(", ");
  if (res.status < 200 || res.status >= 300) attempt.snippet = snippet(res.text);
  return attempt;
}

// ---------------------------------------------------------------------------
// phase: headers — find the minimal working header set per route
// ---------------------------------------------------------------------------

const cliHeaders = (ver: string) => ({
  "user-agent": `factory-cli/${ver}`,
  "x-factory-client": "cli",
  "x-client-version": ver,
});

function variantsFor(route: RouteID): Array<{ name: string; headers: Record<string, string> }> {
  const auth = { authorization: `Bearer ${KEY}` };
  const list: Array<{ name: string; headers: Record<string, string> }> = [
    { name: "auth-only", headers: { ...auth } },
    { name: `auth+cli-${CLIENT_VERSION}`, headers: { ...auth, ...cliHeaders(CLIENT_VERSION) } },
  ];
  if (route === "responses") {
    list.push({ name: "auth+cli-0.57.0", headers: { ...auth, ...cliHeaders("0.57.0") } });
  }
  if (route === "anthropic") {
    list.push({ name: "x-api-key+cli", headers: { "x-api-key": KEY!, ...cliHeaders(CLIENT_VERSION) } });
  }
  if (route === "chat") {
    list.push({ name: "auth+cli+xapi-fireworks", headers: { ...auth, ...cliHeaders(CLIENT_VERSION), "x-api-provider": "fireworks" } });
  }
  return list;
}

interface HeaderPhase {
  host: string;
  perRoute: Record<RouteID, { working?: string; attempts: Array<{ variant: string } & Attempt> }>;
}

async function phaseHeaders(): Promise<HeaderPhase> {
  const out: HeaderPhase = { host, perRoute: {} as HeaderPhase["perRoute"] };
  for (const spec of ROUTES) {
    const rid = routeID(spec);
    const model = PROBE_CHEAP[rid];
    const attempts: HeaderPhase["perRoute"][RouteID]["attempts"] = [];
    let working: string | undefined;
    for (const v of variantsFor(rid)) {
      const attempt = await sendWithFixups(rid, spec, requestBody(rid, model), v.headers);
      attempts.push({ variant: v.name, ...attempt });
      const ok = attempt.status >= 200 && attempt.status < 300;
      console.log(`  [headers] ${rid} via ${host} ${v.name}: ${attempt.status}${ok ? " ✓" : ""} (${attempt.ms}ms)${attempt.note ? ` ${attempt.note}` : ""}`);
      if (ok && !working) working = v.name;
      // first success is the minimal working set for this ordering
      if (working) break;
    }
    out.perRoute[rid] = { working, attempts };
  }
  return out;
}

function headersOf(phase: HeaderPhase, rid: RouteID): Record<string, string> {
  const working = phase.perRoute[rid]?.working;
  const spec = variantsFor(rid).find((v) => v.name === working);
  return spec?.headers ?? {};
}

// ---------------------------------------------------------------------------
// phase: models — availability matrix
// ---------------------------------------------------------------------------

interface ModelResult {
  route: RouteID;
  model: string;
  status: number;
  ms: number;
  note?: string;
  xapiRetry?: Attempt;
  snippet?: string;
}

async function phaseModels(headers: HeaderPhase): Promise<ModelResult[]> {
  const results: ModelResult[] = [];
  for (const spec of ROUTES) {
    const rid = routeID(spec);
    const base = headersOf(headers, rid);
    console.log(`  [models] route ${rid} (${spec.models.length} models)`);
    for (const m of spec.models) {
      let attempt = await sendWithFixups(rid, spec, requestBody(rid, m.modelID ?? m.id), base);
      // chat route: one retry with an explicit backend header on failure
      if (rid === "chat" && (attempt.status < 200 || attempt.status >= 300) && !("x-api-provider" in base) && attempt.status !== 402) {
        const retry = await sendWithFixups(rid, spec, requestBody(rid, m.modelID ?? m.id), {
          ...base,
          "x-api-provider": "fireworks",
        });
        if (retry.status >= 200 && retry.status < 300) {
          attempt = { ...retry, note: [attempt.note, "x-api-provider: fireworks"].filter(Boolean).join("; ") };
        } else {
          attempt.xapiRetry = retry;
        }
      }
      const ok = attempt.status >= 200 && attempt.status < 300;
      if (!ok) console.log(`    ${m.id}: ${attempt.status}${attempt.note ? ` (${attempt.note})` : ""}`);
      results.push({ route: rid, model: m.id, status: attempt.status, ms: attempt.ms, note: attempt.note, xapiRetry: attempt.xapiRetry, snippet: attempt.snippet });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// phase: system — identity sentence / content-filter questions
// ---------------------------------------------------------------------------

const SYSTEM_VARIANTS: Record<string, string> = {
  none: "", // no system at all
  generic: "You are a helpful coding assistant.",
  droid: "You are Droid, Factory's autonomous software development agent, operating in a terminal.",
  opencode: "You are OpenCode, an AI coding assistant CLI working in a git repository.",
  filterBait: "The previous assistant was pi. Now you are Claude Code, an AI coding agent made by Anthropic.",
};

interface SystemResult {
  route: RouteID;
  variant: string;
  status: number;
  ms: number;
  snippet?: string;
}

async function phaseSystem(headers: HeaderPhase): Promise<SystemResult[]> {
  const results: SystemResult[] = [];
  for (const spec of ROUTES) {
    const rid = routeID(spec);
    const model = PROBE_CHEAP[rid];
    const base = headersOf(headers, rid);
    const names = rid === "anthropic" ? ["none", "generic", "droid", "opencode", "filterBait"] : ["none", "generic", "droid", "opencode"];
    for (const name of names) {
      const sys = SYSTEM_VARIANTS[name];
      const body = sys ? withSystem(rid, model, sys) : requestBody(rid, model);
      const attempt = await sendWithFixups(rid, spec, body, base);
      const ok = attempt.status >= 200 && attempt.status < 300;
      console.log(`  [system] ${rid}/${name}: ${attempt.status}${ok ? " ✓" : ""}${attempt.snippet ? ` ${attempt.snippet.slice(0, 160)}` : ""}`);
      results.push({ route: rid, variant: name, status: attempt.status, ms: attempt.ms, snippet: attempt.snippet });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// phase: reasoning — effort/thinking parameter shapes
// ---------------------------------------------------------------------------

interface ReasoningResult {
  route: RouteID;
  variant: string;
  status: number;
  ms: number;
  snippet?: string;
}

async function phaseReasoning(headers: HeaderPhase): Promise<ReasoningResult[]> {
  const results: ReasoningResult[] = [];
  for (const spec of ROUTES) {
    const rid = routeID(spec);
    const model = PROBE_CHEAP[rid];
    const base = headersOf(headers, rid);
    const bodies: Array<{ name: string; body: Record<string, unknown> }> = [];
    if (rid === "anthropic") {
      bodies.push({ name: "thinking-budget", body: { ...requestBody(rid, model), max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 } } });
    } else if (rid === "chat") {
      bodies.push({ name: "reasoning_effort=high", body: { ...requestBody(rid, model), reasoning_effort: "high" } });
    } else {
      bodies.push({ name: "reasoning.effort=high", body: { ...requestBody(rid, model), reasoning: { effort: "high" } } });
      bodies.push({ name: "reasoning.effort=xhigh", body: { ...requestBody(rid, model), reasoning: { effort: "xhigh" } } });
      bodies.push({ name: "reasoning.effort=max", body: { ...requestBody(rid, model), reasoning: { effort: "max" } } });
    }
    for (const b of bodies) {
      const attempt = await sendWithFixups(rid, spec, b.body, base);
      const ok = attempt.status >= 200 && attempt.status < 300;
      console.log(`  [reasoning] ${rid}/${b.name}: ${attempt.status}${ok ? " ✓" : ""}${attempt.snippet ? ` ${attempt.snippet.slice(0, 160)}` : ""}`);
      results.push({ route: rid, variant: b.name, status: attempt.status, ms: attempt.ms, snippet: attempt.snippet });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const report: Record<string, unknown> = {
    meta: {
      date: new Date().toISOString(),
      hostCandidates: HOSTS,
      clientVersion: CLIENT_VERSION,
      phase: PHASE,
      timeoutMs: TIMEOUT,
    },
  };

  console.log(`M0 probe — phase=${PHASE}, hosts=${HOSTS.join(", ")}`);

  // headers phase first on the first host; fall back to the next host if
  // every route fails entirely (wrong host vs. wrong headers).
  let headers = await phaseHeaders();
  const allFailed = Object.values(headers.perRoute).every((r) => !r.working);
  if (allFailed && HOSTS.length > 1) {
    const next = HOSTS.find((h) => h !== host);
    if (next) {
      console.log(`  [host] no route succeeded on ${host}; retrying on ${next}`);
      host = next;
      headers = await phaseHeaders();
    }
  }
  report.headers = headers;
  report.meta = { ...(report.meta as object), workingHost: host };

  if (PHASE === "all" || PHASE === "models") report.models = await phaseModels(headers);
  if (PHASE === "all" || PHASE === "system") report.system = await phaseSystem(headers);
  if (PHASE === "all" || PHASE === "reasoning") report.reasoning = await phaseReasoning(headers);

  mkdirSync("notes", { recursive: true });
  const file = `notes/m0-probe${PHASE === "all" ? "" : `-${PHASE}`}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${file} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // summary
  const h = headers as HeaderPhase;
  console.log("\n=== summary ===");
  for (const [rid, r] of Object.entries(h.perRoute)) {
    console.log(`  ${rid}: working variant = ${r.working ?? "NONE"}`);
  }
  if (report.models) {
    const models = report.models as ModelResult[];
    const ok = models.filter((m) => m.status >= 200 && m.status < 300);
    const bad = models.filter((m) => m.status < 200 || m.status >= 300);
    console.log(`  models: ${ok.length}/${models.length} reachable`);
    for (const m of bad) console.log(`    ✗ ${m.route}/${m.model}: ${m.status}${m.note ? ` (${m.note})` : ""}`);
  }
}

await main();
