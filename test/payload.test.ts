import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { ImageOptimizer } from "../src/images.ts";
import { PayloadManager, jsonBytes } from "../src/payload.ts";
import { DROID_IDENTITY } from "../src/catalog.ts";

function request(path: string, body: unknown) {
  const text = JSON.stringify(body);
  return new Request(`http://fixture.invalid${path}`, {
    method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text,
  });
}

test("image optimization uses bpp, preserves efficient images, and caches original encodes", async () => {
  const optimizer = new ImageOptimizer();
  const png = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "white" } }).png({ compressionLevel: 0 }).toBuffer();
  const image = { mime: "image/png", data: png.toString("base64") };
  const result = await optimizer.optimize(image);
  assert.ok(result.data.length < image.data.length * 0.85);
  assert.deepEqual(await optimizer.optimize(image), result);
  assert.equal((await sharp(Buffer.from(result.data, "base64")).metadata()).width, 1000);
  assert.deepEqual(await optimizer.optimize(result), result);
  assert.deepEqual(await optimizer.optimize({ mime: "image/jpeg", data: "broken" }), { mime: "image/jpeg", data: "broken" });
  optimizer.clear();
});

test("transparent PNGs retain alpha, oversized images resize, and animations stay intact", async () => {
  const optimizer = new ImageOptimizer();
  const png = await sharp({ create: { width: 3000, height: 1500, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.4 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  const result = await optimizer.optimize({ mime: "image/png", data: png.toString("base64") });
  const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
  assert.equal(result.mime, "image/png");
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.width, 2560);
  const gif = { mime: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" };
  assert.deepEqual(await optimizer.optimize(gif), gif);
});

test("under-budget requests without image savings retain their exact Request and UTF-8 accounting", async () => {
  const manager = new PayloadManager();
  const req = request("/v1/responses", { model: "test", instructions: DROID_IDENTITY, input: [{ role: "user", content: "你好😀" }] });
  assert.equal(await manager.prepare(req), req);
  assert.ok(jsonBytes({ text: "😀" }) > JSON.stringify({ text: "😀" }).length);
  assert.throws(() => new PayloadManager({ maxBytes: NaN }));
});

for (const protocol of ["anthropic", "chat", "responses"] as const) {
  test(`${protocol}: prune oldest attachments only when over budget, retain recent visuals and originals`, async () => {
    const manager = new PayloadManager({ maxBytes: 32_000 });
    const image = "!".repeat(30_000); // Malformed image cannot be recompressed; exercise pruning.
    const file = protocol === "anthropic" ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } } :
      protocol === "chat" ? { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } } :
      { type: "input_image", image_url: `data:image/jpeg;base64,${image}` };
    const messages = [{ role: "user", content: [file] }, { role: "assistant", content: "Earlier analysis" },
      { role: "user", content: [file] }];
    const body = { model: "test", ...(protocol === "responses" ? { input: messages, instructions: DROID_IDENTITY } : { messages }) };
    const original = structuredClone(body);
    const req = request(protocol === "anthropic" ? "/v1/messages" : protocol === "chat" ? "/v1/chat/completions" : "/v1/responses", body);
    const result = await manager.prepare(req);
    const parsed = await result.json();
    const items = parsed.input ?? parsed.messages;
    assert.match(items[0].content[0].text, /Older attachment omitted/);
    assert.deepEqual(items[2].content[0], file);
    assert.deepEqual(body, original);
    assert.deepEqual(await req.clone().json(), original);
    assert.ok(jsonBytes(parsed) <= 32_000);
    assert.equal(result.headers.get("content-length"), null);
  });

  test(`${protocol}: summary recovery preserves current tool/ reasoning history and is cached`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (req: Request) => {
      calls++;
      const body = await req.json();
      assert.equal(req.headers.get("authorization"), "Bearer fixture");
      assert.ok(jsonBytes(body) < 32_000);
      assert.match(body.instructions ?? body.system ?? body.messages[0].content, /^You are Droid/);
      assert.equal(body.stream, false);
      if (protocol === "responses") { assert.equal(body.store, false); assert.deepEqual(body.include, ["reasoning.encrypted_content"]); }
      return Response.json(protocol === "responses" ? { output: [{ type: "message", content: [{ type: "output_text", text: "Preserved decisions" }] }] } :
        protocol === "anthropic" ? { content: [{ type: "text", text: "Preserved decisions" }] } :
        { choices: [{ message: { content: "Preserved decisions" } }] });
    });
    const manager = new PayloadManager({ maxBytes: 32_000 });
    const current = protocol === "responses" ? [
      { role: "user", content: "Latest request" },
      { type: "reasoning", encrypted_content: "opaque" },
      { type: "function_call", call_id: "call_1", name: "glob", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ] : protocol === "chat" ? [
      { role: "user", content: "Latest request" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ] : [{ role: "user", content: "Latest request" },
      { role: "assistant", content: [{ type: "thinking", thinking: "thinking", signature: "opaque" }, { type: "tool_use", id: "call_1", name: "glob", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] }];
    const history = [{ role: "user", content: "old text ".repeat(5000) }, { role: "assistant", content: "Old decision" }, ...current];
    const body = { model: "test", ...(protocol === "responses" ? { instructions: DROID_IDENTITY, input: history } : { messages: history }) };
    const req = request(protocol === "responses" ? "/v1/responses" : protocol === "chat" ? "/v1/chat/completions" : "/v1/messages", body);
    const result = await (await manager.prepare(req)).json();
    const items = result.input ?? result.messages;
    assert.ok(jsonBytes(result) < 32_000);
    // Anthropic tool results are also user messages, so use assertions on
    // complete tool pairs below rather than assuming role=user is a turn start.
    assert.deepEqual(items.slice(-current.length), current);
    const firstCalls = calls;
    assert.ok(firstCalls > 0);
    await manager.prepare(req);
    assert.equal(calls, firstCalls);
    manager.clear();
  });
}

test("413 recovery is bounded, makes progress, and preserves SDK response streams", async (t) => {
  const manager = new PayloadManager({ maxBytes: 64_000 });
  const body = { model: "test", instructions: DROID_IDENTITY, input: [
    { role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${"!".repeat(25_000)}` }] },
    { role: "assistant", content: "analysis" }, { role: "user", content: "new request" },
  ] };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    calls++;
    assert.ok(Buffer.byteLength(await req.text()) < jsonBytes(body));
    return new Response("data: fixture\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const req = request("/v1/responses", body);
  const response = new Response("too large", { status: 413 });
  const recovered = await manager.recover(req, response);
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), "data: fixture\n\n");
  assert.equal(calls, 1);
  const small = request("/v1/responses", { input: [{ role: "user", content: "hi" }] });
  const failed = new Response("too large", { status: 413 });
  assert.equal(await manager.recover(small, failed), failed);
  assert.equal(calls, 1);
});

test("single-turn large tool output is summarized without removing its call or reasoning", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ output: [
    { type: "message", content: [{ type: "output_text", text: "Important tool findings" }] },
  ] }));
  const items = [{ role: "user", content: "Do the task" }, { type: "reasoning", encrypted_content: "encrypted" },
    { type: "function_call", call_id: "call", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "large output ".repeat(4000) }];
  const manager = new PayloadManager({ maxBytes: 32_000 });
  const result = await (await manager.prepare(request("/v1/responses", { model: "test", input: items }))).json();
  assert.deepEqual(result.input.slice(0, 3), items.slice(0, 3));
  assert.equal(result.input[3].call_id, "call");
  assert.match(result.input[3].output, /Important tool findings/);
  assert.ok(jsonBytes(result) < 32_000);
});

test("PDFs and nested Anthropic tool images are omitted without breaking tool result IDs", async () => {
  const manager = new PayloadManager({ maxBytes: 32_000 });
  const items = [{ role: "user", content: "old request" },
    { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x".repeat(40_000) } },
    ] }] }, { role: "user", content: "latest request" }];
  const result = await (await manager.prepare(request("/v1/messages", { model: "test", messages: items }))).json();
  assert.equal(result.messages[2].content[0].tool_use_id, "tool");
  assert.match(result.messages[2].content[0].content[0].text, /Older attachment omitted/);
  assert.equal(result.messages[3].content, "latest request");
});

test("unrecognized routes and remote images are never fetched or rewritten", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network access"); });
  const manager = new PayloadManager();
  for (const path of ["/other", "/v1/chat/completions"]) {
    const req = request(path, { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://example.com/private-image.png" } },
    ] }] });
    assert.equal(await manager.prepare(req), req);
  }
});

test("summary failures and cancellation do not mutate originals or trigger retry storms", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("unavailable", { status: 503 }); });
  const manager = new PayloadManager({ maxBytes: 32_000 });
  const body = { model: "test", input: [{ role: "user", content: "x".repeat(40_000) }, { role: "user", content: "new" }] };
  const req = request("/v1/responses", body);
  await assert.rejects(manager.prepare(req), /HTTP 503/);
  assert.equal(calls, 1);
  assert.deepEqual(await req.json(), body);
});

for (const protocol of ["anthropic", "chat", "responses"] as const) {
  test(`${protocol}: old inline images expire below budget before optimization, with stable notices`, async () => {
    const manager = new PayloadManager({ imageRetentionMessages: 2 });
    const image = protocol === "anthropic" ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "broken" } } :
      protocol === "chat" ? { type: "image_url", image_url: { url: "data:image/jpeg;base64,broken" } } :
      { type: "input_image", image_url: "data:image/jpeg;base64,broken" };
    const items = [{ role: "user", content: [image] }, { role: "assistant", content: "analysis" },
      { role: "user", content: "next" }];
    const notices: Array<{ key: string; kind: string }> = [];
    const path = protocol === "anthropic" ? "/v1/messages" : protocol === "chat" ? "/v1/chat/completions" : "/v1/responses";
    const run = async () => {
      const body = { model: "test", [protocol === "responses" ? "input" : "messages"]: items };
      return (await manager.prepare(request(path, body), manager.maxBytes, async (notice) => { notices.push(notice); })).json();
    };
    const result = await run();
    assert.match((result.input ?? result.messages)[0].content[0].text, /Older attachment omitted/);
    assert.deepEqual(items[0].content, [image], "saved originals remain untouched");
    assert.deepEqual(notices.map((notice) => notice.kind), ["attachments"]);
    items.push({ role: "assistant", content: "more analysis" });
    await run();
    assert.equal(notices[0].key, notices[1].key, "continuations must not re-toast the same omission");
  });
}

test("retention boundary and latest user attachments are protected, and invalid windows fail clearly", async () => {
  assert.throws(() => new PayloadManager({ imageRetentionMessages: 0 }), /positive integer/);
  assert.throws(() => new PayloadManager({ imageRetentionMessages: 1.5 }), /positive integer/);
  const image = { type: "input_image", image_url: "data:image/jpeg;base64,broken" };
  const manager = new PayloadManager({ imageRetentionMessages: 2 });
  const items = [{ role: "user", content: "earlier" }, { role: "assistant", content: [image] },
    { role: "user", content: [image] }, { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call", call_id: "one", name: "glob", arguments: "{}" },
    { type: "function_call_output", call_id: "one", output: "done" }];
  const req = request("/v1/responses", { model: "test", input: items });
  assert.equal(await manager.prepare(req), req, "reasoning and function items must not age images");
});
