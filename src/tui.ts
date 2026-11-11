import { Plugin } from "@opencode/plugin/tui";
import { createElement, spread } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createEffect, createSignal } from "solid-js";
import { FactoryActivity, type ActivityEntry } from "./activity-rpc";

export default Plugin.define({
  id: "opencode-factory.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(FactoryActivity);
    const [logs, setLogs] = createSignal<Record<string, ActivityEntry[]>>({});
    const shown = new Set<string>();
    let disposed = false;
    const load = async (sessionID: string, notify = false, location?: { directory: string }) => {
      try {
        const result = await rpc.list({ sessionID }, { location: location ?? ctx.data.session.get(sessionID)?.location ?? ctx.location });
        const { entries } = result as { entries: ActivityEntry[] };
        if (disposed) return;
        const known = logs()[sessionID];
        setLogs((previous) => ({ ...previous, [sessionID]: entries }));
        for (const entry of entries) {
          if (shown.has(entry.id)) continue;
          shown.add(entry.id);
          if (notify && Date.now() - entry.time < 30_000 && !known?.some((old) => old.id === entry.id)) {
            ctx.ui.toast.show({ title: "Factory", message: entry.message, variant: "info", duration: 5000 });
          }
        }
        if (shown.size > 2000) shown.clear();
      } catch { /* Server-only installs and unloading must not break the TUI. */ }
    };
    const stop = rpc.events.on("updated", (event) => {
      const { sessionID } = event.data as { sessionID: string };
      if (ctx.data.session.get(sessionID)) void load(sessionID, true, event.location);
    });
    const remove = ctx.ui.slot({
      append: "session.composer.top",
      render: (props) => {
        const [expanded, setExpanded] = createSignal(false);
        // A slot is mounted per session composer; load durable history on mount.
        createEffect(() => { void load(props.sessionID); });
        const entries = () => logs()[props.sessionID] ?? [];
        // Use the public renderer primitives rather than uncompiled JSX. Git/npm
        // installs don't include tsconfig.json, and the CLI's default TSX loader
        // otherwise emits React calls. Getters preserve Solid reactivity.
        return element("box", {
          flexDirection: "column",
          get children() {
            if (!entries().length) return [];
            return element("box", {
              flexDirection: "column", paddingLeft: 1, paddingRight: 1,
              get children() {
                return [
                  element("text", {
                    fg: ctx.theme.text.base,
                    onMouseDown: () => setExpanded(!expanded()),
                    get children() { return `${expanded() ? "▾" : "▸"} Factory activity (${entries().length}) — click to ${expanded() ? "collapse" : "expand"}`; },
                  }),
                  ...(expanded() ? [element("scrollbox", {
                        get height() { return Math.min(8, entries().length); },
                        get children() {
                          return entries().map((entry) => element("text", {
                              fg: ctx.theme.text.base,
                              children: `${new Date(entry.time).toLocaleTimeString()} · ${entry.message}`,
                            }));
                        },
                      })] : []),
                ];
              },
            });
          },
        });
      },
    });
    return () => { disposed = true; stop(); remove(); };
  },
});

function element(type: "box" | "text" | "scrollbox", props: Record<string, unknown>): JSX.Element {
  const node = createElement(type);
  spread(node, props);
  return node as unknown as JSX.Element;
}
