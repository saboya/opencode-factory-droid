import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_VERSION, DROID_IDENTITY } from "../src/catalog.ts";

const failures: unknown[] = [];
let calls = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/organization/managed-settings") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ settings: { modelPolicy: {
        allowAllFactoryModels: false, allowedModelIds: ["glm-5.3-flash"], blockedModelIds: [],
      } } }));
      return;
    }
    assert.equal(request.url, "/api/llm/o/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    assert.equal(request.headers["x-api-provider"], "fireworks");
    assert.equal(request.headers["x-client-version"], CLIENT_VERSION);
    assert.equal(request.headers["x-factory-client"], "cli");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.messages[0].role, "system");
    assert.ok(body.messages[0].content.startsWith(DROID_IDENTITY));
    calls++;
    const completion = {
      id: "fixture", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    };
    if (!body.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completion));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) {
      response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [choice] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    failures.push(error);
    response.writeHead(500).end("fixture assertion failed");
  }
});

const directory = await mkdtemp(join(tmpdir(), "opencode-factory-smoke-"));
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  await mkdir(join(directory, ".opencode/plugins"), { recursive: true });
  await writeFile(join(directory, ".opencode/plugins/factory.ts"),
    `export { default } from ${JSON.stringify(fileURLToPath(new URL("../src/index.ts", import.meta.url)))};\n`);
  await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [] }));
  const home = join(directory, "home");
  await mkdir(home);
  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", [
    "run", "--standalone", "--model", "factory-o/glm-5.3-flash", "Reply with pong.",
  ], {
    cwd: directory,
    env: {
      ...process.env, PWD: directory,
      OPENCODE: "", OPENCODE_SESSION_ID: "", OPENCODE_TERMINAL: "", AI_AGENT: "",
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
      FACTORY_API_KEY: "fixture-only", FACTORY_API_BASE_URL: base, FACTORY_APP_BASE_URL: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.deepEqual(failures, []);
    assert.equal(code, 0, output);
    assert.ok(calls > 0, output);
    assert.match(output, /pong/);
    console.log(`OpenCode smoke passed (${calls} fixture requests; no subscription usage).`);
  } finally {
    clearTimeout(timer);
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
