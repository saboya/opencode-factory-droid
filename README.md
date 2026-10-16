# opencode-factory-plugin

Use Factory (Droid) models inside OpenCode's own agent loop. This TypeScript
plugin registers Factory's LLM gateway as three OpenCode providers, using your
Factory API key for authentication.

## Features

- Streaming responses and tool calls through Anthropic Messages, OpenAI Chat
  Completions, and OpenAI Responses.
- Factory client headers and system-prompt identity applied to main and auxiliary
  requests, including title generation.
- Organization-policy filtering at startup, with a persistent last-known policy
  cache for transient failures.
- Generated upstream cost and context/output-limit metadata from
  [models.dev](https://models.dev).

| Provider | Protocol | Model families |
| --- | --- | --- |
| `factory` | Anthropic Messages | Claude |
| `factory-o` | OpenAI Chat Completions | Gemini, Grok, GLM, Kimi, Qwen, MiniMax, DeepSeek, Mistral, Nemotron, Inkling |
| `factory-gpt` | OpenAI Responses | GPT |

The static catalog defines 44 models. The models shown in OpenCode depend on your
organization's policy; regional backend availability can further restrict access.

## Compatibility

This plugin currently targets the **OpenCode V2 beta catalog API**:

| Component | Verified version |
| --- | --- |
| OpenCode CLI (`opencode2`) | `0.0.0-beta-19242` |
| `@opencode/plugin` | `0.0.0-beta-19507` |
| Factory client header version | `0.243.0` |

It uses `ctx.catalog` and `aisdk:` provider packages. The newer V2 plugin API
documented with `ctx.provider` / `ctx.model` is different; compatibility with that
API has not been verified.

For development scripts, use **Node.js 22.18+** (native TypeScript support) and npm.
You also need a Factory API key with access to the models you want to use.

## Quick start

### 1. Install from source

Clone this repository, then install the locked dependencies:

```sh
git clone <repository-url> opencode-factory-plugin
cd opencode-factory-plugin
npm ci
```

### 2. Set your Factory API key

Create a key in [Factory settings](https://app.factory.ai/settings/api-keys), then
export it in the environment used to start OpenCode:

```sh
export FACTORY_API_KEY="your-factory-api-key"
```

The plugin fails at load time with a clear error when this variable is missing.
It reads the environment directly; it does not load `.env` files or perform OAuth.

### 3. Load the plugin

**In this checkout:** the included `.opencode/plugins/factory.ts` loader imports
`src/index.ts` automatically. Start OpenCode from the checkout directory.

**In another project:** create `.opencode/plugins/factory.ts` in that project with
the following content, replacing the path with the absolute path to your clone:

```ts
export { default } from "/absolute/path/to/opencode-factory-plugin/src/index.ts";
```

The loader shim is the verified loading method for the beta CLI above. Restart
OpenCode and its background service after installing or updating the plugin so it
loads the current code and environment.

### 4. Pick a model

Use `/models` in OpenCode, or run a standalone smoke check:

```sh
opencode2 run --standalone -m factory/claude-haiku-5-5 "say pong"
opencode2 run --standalone -m factory-o/glm-5.3-flash "say pong"
opencode2 run --standalone -m factory-gpt/gpt-6-luna "say pong"
```

These examples require the corresponding models to be allowed for your account.

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `FACTORY_API_KEY` | Factory bearer token (required) | — |
| `FACTORY_API_BASE_URL` | LLM gateway base URL | `https://prem.factory.ai` |
| `FACTORY_APP_BASE_URL` | App API base URL for organization policy | `https://app.factory.ai` |

The policy is fetched once per plugin setup. Explicitly blocked models are hidden;
when the organization uses an allowlist, only listed models are registered. If the
fetch fails, the plugin uses its cached policy. Without a cache, it registers the
full catalog. Restart the service to pick up policy changes.

## Metadata and limitations

- **Cost estimates:** prices are upstream vendor list prices, not Factory charges
  or subscription-quota usage.
- **Context limits:** windows come from models.dev's upstream records. They guide
  OpenCode's compaction timing; Factory-specific serving limits have not been
  exhaustively verified.
- **Regional routing:** organization approval does not guarantee backend
  availability. Grok, for example, failed in the tested region despite being
  allowlisted.
- **Retries:** OpenCode's built-in retry behavior is used; Factory-specific retry
  tuning and automatic backend rotation are not implemented.
- **Gateway changes:** model IDs, routing headers, and client requirements may
  need updates when Factory changes its gateway.

## Development

```sh
npm run typecheck
npm run gen-models
```

`gen-models` fetches models.dev and regenerates the committed
`src/models.gen.ts` cost and limit tables. To use a downloaded dataset:

```sh
node scripts/gen-models.mjs /path/to/models-dev-api.json
```

An optional HTTP probe writes diagnostic results to `notes/m0-probe.json`
(ignored by Git). It makes real API calls using your Factory account:

```sh
FACTORY_API_BASE_URL=https://prem.factory.ai npm run probe
```

## Documentation

- [Factory gateway behavior](docs/factory-droid-behavior.md) — endpoints,
  authentication, identity requirements, routing, organization policy, and errors.
- [Reverse-engineering playbook](docs/reverse-engineering-playbook.md) — the
  investigation and verification methodology.
- [Project handoff](HANDOFF.md) — implementation history, verified behavior, and
  remaining work.

---

This project is unaffiliated with Factory or OpenCode.
