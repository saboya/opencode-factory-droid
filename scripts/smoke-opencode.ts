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
const requestedModels = new Set<string>();
let titles = 0;
let responsesCalls = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/organization/managed-settings") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ settings: { modelPolicy: {
        allowAllFactoryModels: false, allowedModelIds: ["glm-5.3-flash", "gpt-6.1-sol"], blockedModelIds: [],
      } } }));
      return;
    }
    if (request.url === "/free/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      assert.equal(JSON.parse(raw).model, "big-pickle");
      assert.notEqual(request.headers.authorization, "Bearer fixture-only");
      titles++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "title", object: "chat.completion", created: 1, model: "big-pickle",
        choices: [{ index: 0, message: { role: "assistant", content: "Fixture title" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
      return;
    }
    if (request.url === "/api/llm/o/v1/responses") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.model, "gpt-6.1-sol");
      assert.equal(request.headers.authorization, "Bearer fixture-only");
      assert.equal(request.headers["x-api-provider"], "openai");
      assert.ok(body.instructions.startsWith(DROID_IDENTITY));
      assert.equal(body.store, false);
      assert.ok(body.include.includes("reasoning.encrypted_content"));
      assert.ok(!body.input.some((item: any) => item.type === "item_reference"));
      const auxiliary = !body.tools?.length;
      if (!auxiliary) responsesCalls++;
      const followup = responsesCalls > 1;
      if (followup) {
        assert.ok(body.input.some((item: any) => item.type === "reasoning" && item.encrypted_content === "fixture-encrypted-reasoning"));
        assert.ok(body.input.some((item: any) => item.type === "function_call" && item.call_id === "call_fixture"));
        assert.ok(body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_fixture"));
      }
      const output = followup || auxiliary ? [{
        type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "pong", annotations: [] }],
      }] : [
        { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Check files." }], encrypted_content: "fixture-encrypted-reasoning" },
        { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "glob", arguments: '{"pattern":"package.json"}', status: "completed" },
      ];
      const result = {
        id: `resp_fixture_${responsesCalls}`, object: "response", created_at: 1,
        model: body.model, status: "completed", output,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } },
      };
      response.setHeader("content-type", "text/event-stream");
      let sequence_number = 0;
      const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...data })}\n\n`);
      emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
      for (const [output_index, item] of output.entries()) {
        emit("response.output_item.added", { output_index, item });
        if (item.type === "reasoning") {
          emit("response.reasoning_summary_text.delta", { item_id: item.id, output_index, summary_index: 0, delta: "Check files." });
        }
        if (item.type === "message") {
          emit("response.output_text.delta", { item_id: item.id, output_index, content_index: 0, delta: "pong" });
        }
        emit("response.output_item.done", { output_index, item });
      }
      emit("response.completed", { response: result });
      response.end();
      return;
    }
    assert.equal(request.url, "/api/llm/o/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    assert.equal(request.headers["x-client-version"], CLIENT_VERSION);
    assert.equal(request.headers["x-factory-client"], "cli");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(request.headers["x-api-provider"], "fireworks");
    requestedModels.add(body.model);
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
    response.writeHead(400).end("fixture assertion failed");
  }
});

const directory = await mkdtemp(join(process.env.OPENCODE_TMP_DIR ?? tmpdir(), "opencode-factory-smoke-"));
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  await mkdir(join(directory, ".opencode/plugins"), { recursive: true });
  await writeFile(join(directory, ".opencode/plugins/factory.ts"),
    `import plugin from ${JSON.stringify(fileURLToPath(new URL("../src/index.ts", import.meta.url)))};
export default { ...plugin, async setup(ctx) {
await ctx.model.transform(editor => editor.update("opencode", "big-pickle", model => {
model.package = "aisdk:@ai-sdk/openai-compatible";
model.settings = { baseURL: "${base}/free/v1", apiKey: "free-fixture" };
}));
return plugin.setup(ctx);
} };\n`);
  await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [] }));
  const home = join(directory, "home");
  await mkdir(home);
  for (const model of ["factory-o/glm-5.3-flash", "factory-gpt/gpt-6.1-sol"]) {
    const child = spawn(process.env.OPENCODE_BIN ?? "opencode", [
      "run", "--standalone", "--model", model, "Reply with pong.",
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
      if (failures.length) console.error(output);
      assert.deepEqual(failures, []);
      assert.equal(code, 0, output);
      assert.ok(calls > 0, output);
      assert.match(output, /pong/);
      assert.deepEqual([...requestedModels], ["glm-5.3-flash"]);
      assert.ok(titles > 0, "titles must use the OpenCode free model, not Factory");
    } finally {
      clearTimeout(timer);
    }
  }
  assert.equal(responsesCalls, 2, "Responses reasoning and tool output must replay statelessly");
  console.log(`OpenCode smoke passed (${calls} Chat requests, ${responsesCalls} Responses steps; no subscription usage).`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
