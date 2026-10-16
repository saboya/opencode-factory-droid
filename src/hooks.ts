import { Plugin } from "@opencode/plugin";
import { CLIENT_VERSION, DROID_IDENTITY } from "./catalog";

/** The setup context `Plugin.define` hands to `setup`, without importing an internal path. */
type SetupContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/** Hook kinds whose event carries a mutable `system: SystemPart[]` we can prepend to. */
const IDENTITY_KINDS = ["context", "generate", "title", "compaction"] as const;

/**
 * Prepend DROID_IDENTITY to the gated field of a parsed Factory request body,
 * per wire protocol. Returns true when the body was modified.
 */
function injectIdentity(pathname: string, body: Record<string, unknown>): boolean {
  if (pathname.endsWith("/messages")) {
    // Anthropic: top-level `system` is string | Array<{type:"text",text}>.
    const system = body["system"];
    if (typeof system === "string") {
      if (system.startsWith(DROID_IDENTITY)) return false;
      body["system"] = `${DROID_IDENTITY}\n${system}`;
      return true;
    }
    if (Array.isArray(system)) {
      const first = system[0] as { type?: string; text?: string } | undefined;
      if (first && first.type === "text" && typeof first.text === "string" && first.text.startsWith(DROID_IDENTITY)) {
        return false;
      }
      system.unshift({ type: "text", text: DROID_IDENTITY });
      return true;
    }
    body["system"] = [{ type: "text", text: DROID_IDENTITY }];
    return true;
  }

  if (pathname.endsWith("/chat/completions")) {
    const messages = body["messages"];
    if (!Array.isArray(messages)) return false;
    const first = messages[0] as { role?: string; content?: unknown } | undefined;
    if (first && first.role === "system" && typeof first.content === "string") {
      if (first.content.startsWith(DROID_IDENTITY)) return false;
      first.content = `${DROID_IDENTITY}\n${first.content}`;
      return true;
    }
    messages.unshift({ role: "system", content: DROID_IDENTITY });
    return true;
  }

  if (pathname.endsWith("/responses")) {
    // Responses: gated field is top-level `instructions`; any developer/system
    // role inside `input` 403s, so only touch instructions.
    const instructions = body["instructions"];
    if (typeof instructions === "string") {
      if (instructions.startsWith(DROID_IDENTITY)) return false;
      body["instructions"] = `${DROID_IDENTITY}\n${instructions}`;
      return true;
    }
    body["instructions"] = DROID_IDENTITY;
    return true;
  }

  return false;
}

export interface FactoryHookOptions {
  /** Factory API key; enforced as `authorization: Bearer …` on every request. */
  key: string;
  /** Resolve the upstream backend (`x-api-provider` header) for a wire model ID. */
  providerForModel: (modelID: string) => string;
}

/**
 * Factory's premium LLM proxy rejects (HTTP 403 "Forbidden") any request whose
 * system prompt does not *begin* with DROID_IDENTITY. OpenCode builds its own
 * system prompt, so every request routed through our providers must carry the
 * identity on the protocol's gated field:
 *   /messages         -> top-level `system` (text blocks)
 *   /chat/completions -> first `messages[]` entry with role "system"
 *   /responses        -> top-level `instructions`
 *
 * Two hook layers enforce this, because neither alone covers everything:
 *
 *  1. Session request hooks (`context`, `generate`, `title`, `compaction`)
 *     prepend a synthetic system part. This is the clean path, but the
 *     `title`/`compaction` kinds do not fire on every CLI build (verified:
 *     title requests bypass them on 0.0.0-beta-19242).
 *  2. The `http.request` hook rewrites the outgoing body as a fallback. It
 *     fires for every provider HTTP request (including title/compaction) on
 *     all builds tested, and is idempotent — bodies already carrying the
 *     identity are left untouched.
 *
 * Headers are forced in the `model.request` hook: Factory needs a bearer token
 * on every route and a per-model `x-api-provider` on the OpenAI routes, while
 * the AI-SDK packages choose their own auth header shape (`x-api-key` for
 * Anthropic, `Authorization` for OpenAI) — see §6.2/§6.3 of HANDOFF.md.
 *
 * All hooks are scoped per providerID: requests to unrelated providers
 * (OpenAI, Anthropic, local models) are left untouched.
 */
export async function registerFactoryHooks(
  ctx: SetupContext,
  providerIDs: readonly string[],
  options: FactoryHookOptions,
): Promise<Array<{ dispose: () => Promise<void> }>> {
  const registrations: Array<{ dispose: () => Promise<void> }> = [];

  for (const providerID of providerIDs) {
    for (const kind of IDENTITY_KINDS) {
      const registration = await ctx.session.hook(
        kind,
        (session) => {
          const first = session.system[0];
          if (first && typeof first.text === "string" && first.text.startsWith(DROID_IDENTITY)) {
            return;
          }
          session.system.unshift({ type: "text", text: DROID_IDENTITY });
        },
        { providerID },
      );
      registrations.push(registration);
    }

    // Belt-and-braces for the wire headers (§6.2/§6.3 of HANDOFF.md): the
    // AI-SDK packages decide their own auth header shape (`x-api-key` for
    // Anthropic, `Authorization` for OpenAI), but Factory requires a bearer
    // token on every route and a per-model `x-api-provider` on the OpenAI
    // routes. The `model.request` hook exposes the outgoing request config,
    // so we force the required headers here regardless of SDK behaviour.
    const headerRegistration = await ctx.session.hook(
      "model.request",
      (request) => {
        request.headers["authorization"] = `Bearer ${options.key}`;
        request.headers["x-factory-client"] = "cli";
        request.headers["x-client-version"] = CLIENT_VERSION;
        const upstream = options.providerForModel(request.model.id);
        if (upstream) request.headers["x-api-provider"] = upstream;
      },
      { providerID },
    );
    registrations.push(headerRegistration);

    // Wire-level identity injection. The `title`/`compaction` session hook
    // kinds do not fire on every CLI build (verified: title requests bypass
    // them on 0.0.0-beta-19242), but `http.request` fires for every outgoing
    // provider HTTP request. Request bodies are immutable, so we rebuild the
    // request with the Droid identity prepended to the protocol's gated field:
    //   /messages            -> top-level `system` (text blocks)
    //   /chat/completions    -> first `messages[]` entry with role "system"
    //   /responses           -> top-level `instructions`
    const httpReg = await ctx.session.hook(
      "http.request",
      async (event) => {
        const request = event.request;
        if (request.method !== "POST") return;
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/messages") && !url.pathname.endsWith("/chat/completions") && !url.pathname.endsWith("/responses")) {
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = (await request.clone().json()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (injectIdentity(url.pathname, body)) {
          event.request = new Request(request, {
            body: JSON.stringify(body),
          });
        }
      },
      { providerID },
    );
    registrations.push(httpReg);
  }

  return registrations;
}
