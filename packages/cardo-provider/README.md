# @cardo/cardo-provider

Cardo's in-house dual-protocol LLM provider plugin (DeepSeek Harness). Ships as a **workspace built-in**, copied into the profile by `packages/cardo-desktop` (see `BUILTIN_WORKSPACE_PLUGINS` in `builtin.ts`).

## Capabilities

- **Dual protocol**: OpenAI chat completions (`/chat/completions`) and Responses API (`/responses`, SSE) — any OpenAI-compatible gateway works; protocol overridable per model (`api: 'chat-completions' | 'responses'`)
- **models.dev auto-detection**: context window / max output tokens / reasoning efforts matched and filled in automatically, one-click fetch from the Web settings page
- **Web settings page**: add gateways (base URL + API key), per-model management, proxy support (undici `ProxyAgent`)

## Wire formats and reasoning preservation

Both protocols hold the same invariant: **any non-empty reasoning fragment the wire emits must reach the harness's `reasoning` block, and reasoning from prior turns must be passed back to the gateway — no loss, no duplication**.

- **Chat Completions receive**: `delta.reasoning_content` (DeepSeek/Qwen/GLM), `delta.reasoning` (OpenRouter-style aggregators), and the terminal chunk's `message.reasoning_content` / `message.reasoning` full-text replay (DashScope compatible mode) — replays append only when nothing streamed, avoiding duplication
- **Chat Completions send back**: tool-call turns carry `reasoning_content` on the assistant message (required by DeepSeek)
- **Responses receive**: `response.reasoning_text.delta/.done`, `response.reasoning_summary_text.delta/.done`, `reasoning` output items (`content` / `summary`), `content_part.*` `reasoning_text` parts, and the `response.completed` / `response.incomplete` `response.output` fallback — whole-item replays are skipped when the item already streamed deltas
- **Responses send back**: every assistant turn (tool-call and non-tool-call) emits a `reasoning` item before its `function_call` items / assistant message (`content` + `summary` sent together; OpenAI requires `summary`, DeepSeek merges `content`). DeepSeek's Responses API in thinking mode rejects a multi-turn tool-call continuation unless the prior turn's `reasoning_text` is replayed this way
- **Tests**: `test/reasoning-preservation.test.mjs` — per-wire-shape regressions + seeded randomized properties (300 rounds of random interleaving, locking no-loss/no-duplication)

## Development

```bash
pnpm --filter @cardo/cardo-provider run build       # tsc (types) + esbuild host+client bundle → lib/
pnpm --filter @cardo/cardo-provider test            # build + node:test composition/dual-protocol translate tests
pnpm --filter @cardo/cardo-provider run lint        # eslint src
pnpm --filter @cardo/cardo-provider run typecheck   # host + client tsconfigs
```

After changing `src/` run `pnpm run build`: the desktop's workspace built-in provisioning copies `lib/` (the build output) — a stale `lib/` ships an outdated plugin into the profile.

## Build output layout

- `lib/index.js` — host bundle (ESM, self-contained: runtime deps inlined, only `@deepseek-ai/*` peers external)
- `lib/client.js` — browser bundle (CJS closure factory, loaded by the dsh client module loader)
- `lib/types/` — tsc declaration emit (`.ts` specifiers in `.d.ts` rewritten to `.js`)

## Configuration

Namespace `llm-cardo`; provider id `cardo`. The registered gateway goes through `ctx.llm.registerConfigurableProvider`; models.dev detection goes through `registerModelDiscovery`. The API key is stored in cardo credentials.
