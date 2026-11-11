import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testRender } from "@opentui/solid";
import type { Plugin } from "@opencode/plugin/tui";

// Run with Bun: tests the packed artifact without tsconfig, JSX preloads, or
// React, just like OpenCode's package loader (not a server-only re-export shim).
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(process.env.OPENCODE_TMP_DIR ?? tmpdir(), "factory-tui-smoke-"));
let cleanup: (() => void | Promise<void>) | void = undefined;
let ui: Awaited<ReturnType<typeof testRender>> | undefined;
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" }))[0];
  execFileSync("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
  const packagePath = join(directory, "package");
  const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
  assert.ok(!packed.files.some((file: { path: string }) => file.path === "tsconfig.json"));
  await mkdir(join(packagePath, "node_modules"));
  // Resolve only the host-supplied public runtimes, not arbitrary repo packages.
  for (const scope of ["@opencode", "@opentui", "solid-js"]) {
    await symlink(join(root, "node_modules", scope), join(packagePath, "node_modules", scope));
  }
  const plugin = (await import(join(packagePath, manifest.exports["./tui"]))).default as Plugin.Definition;
  assert.equal(plugin.id, "opencode-factory.tui");
  let slot: { render: (props: { sessionID: string }) => unknown } | undefined;
  let footer: typeof slot;
  let updated: ((event: unknown) => void) | undefined;
  let message = "Optimized 2 images: 1.20 MB → 0.30 MB.";
  const toasts: unknown[] = [];
  const entries = [{ id: "first", time: Date.now(), sessionID: "fixture", kind: "images", message }];
  cleanup = await plugin.setup({
    client: { rpc: () => ({
      list: async () => ({ entries: [...entries], payload: { bytes: 2_800_000, budget: 4_000_000, time: Date.now() } }),
      events: { on: (_event: string, handler: (event: unknown) => void) => { updated = handler; return () => {}; } },
    }) },
    data: { session: { get: () => ({ location: { directory } }) } },
    theme: { text: { base: "#ffffff" } },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) }, slot: (claim: NonNullable<typeof slot> & { append: string }) => {
      if (claim.append === "prompt.footer.status") footer = claim;
      else slot = claim;
      return () => {};
    } },
  } as unknown as Plugin.Context);
  assert.ok(slot);
  ui = await testRender(() => slot!.render({ sessionID: "fixture" }) as never, { width: 100, height: 20 });
  await ui.waitForFrame((frame) => frame.includes("Factory activity (1)"));
  assert.equal(toasts.length, 0, "loading old entries must not replay toasts");
  const toggle = async () => {
    const lines = ui!.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Factory activity"));
    assert.ok(y >= 0, "expandable heading must be visible");
    await ui!.mockMouse.click(2, y);
  };
  await toggle();
  await ui.waitForFrame((frame) => frame.includes(message));
  message = "Factory byte budget exceeded: using a summary of earlier request history.";
  entries.push({ id: "second", time: Date.now(), sessionID: "fixture", kind: "summary", message });
  updated!({ data: { sessionID: "fixture" }, location: { directory } } as never);
  await ui.waitForFrame((frame) => frame.includes("Factory activity (2)") && frame.includes(message));
  assert.equal(toasts.length, 1, "new entries must toast and persist in the section");
  await toggle();
  await ui.waitForFrame((frame) => frame.includes("click to expand") && !frame.includes(message));
  await ui.dispose();
  ui = await testRender(() => footer!.render({ sessionID: "fixture" }) as never, { width: 100, height: 4 });
  await ui.waitForFrame((frame) => frame.includes("Factory last payload: 2.80 / 4.00 MB"));
  console.log("Packed TUI smoke passed (load, activity log, toast, payload footer; no model calls).");
} finally {
  await ui?.dispose();
  if (typeof cleanup === "function") await cleanup();
  await rm(directory, { recursive: true, force: true });
}
