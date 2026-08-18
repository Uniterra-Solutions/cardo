# Module: cardo-provider

**Purpose:** In-house dual-protocol LLM provider plugin for DeepSeek Harness (`@cardo/cardo-provider`, route `llm-cardo`): OpenAI chat completions AND Responses API over any OpenAI-compatible gateway, with models.dev context/output/reasoning auto-detection and a Web settings page. Ships as a workspace built-in.

Source: `packages/cardo-provider/src/`; tests `test/*.mjs`; build `scripts/build-*.mjs`.

## Files

| File                                          | Responsibility                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                | Plugin entry: `apply(ctx, config)` registers adapter route, model discovery, models.dev RPC channel, settings section; defines `Config` schema |
| `src/adapter.ts`                              | `CardoAdapter extends LlmAdapter`: per-model protocol routing, stream/request path, `GET /models` discovery, models.dev fetch + matching       |
| `src/types.ts`                                | Wire-format types only (Chat Completions + Responses + models.dev)                                                                             |
| `src/sse.ts`                                  | SSE byte-stream → data payload decoding (`parseSse`, `DONE = '[DONE]'`)                                                                        |
| `src/serialize-chat.ts`                       | Harness messages → Chat Completions request body                                                                                               |
| `src/serialize-response.ts`                   | Harness messages → Responses API `input` items                                                                                                 |
| `src/translate-chat.ts`                       | Chat SSE → harness `StreamChunk`s (`[DONE]`-terminated)                                                                                        |
| `src/translate-response.ts`                   | Responses SSE events → harness `StreamChunk`s (terminal event, no `[DONE]`)                                                                    |
| `src/client/*`                                | Browser half: settings page React component, locale, models.dev params UI                                                                      |
| `scripts/build-host.mjs` / `build-client.mjs` | esbuild → self-contained `lib/index.js` (ESM, deps inlined) / `lib/client.js` (`window.__ModuleLoader__` factory)                              |

## Plugin Registration

| Fact          | Value                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host entry    | `name = 'llm-cardo'`, `inject = ['llm']`, `apply(ctx, config)` (`src/index.ts:64-65, 276`)                                                               |
| Bundle patch  | `cordis.patch.yml` inserts `{ id: llm-cardo, name: '@cardo/cardo-provider' }` into profile composition                                                   |
| Client inject | `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings'] }` |

## Public API (host)

| Symbol                                               | Signature                                                                                                                                                                                                        | Description                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apply`                                              | `(ctx: Context, config: Config) => void`                                                                                                                                                                         | Registers adapter route, discovery, RPC, settings section |
| `Config`                                             | schemastery schema                                                                                                                                                                                               | Validated plugin config (below)                           |
| `resolveAdapterOptions`                              | `(config, environment?) => CardoConnectionOptions`                                                                                                                                                               | Raw config → validated connection facts                   |
| `CardoAdapter`                                       | `class extends LlmAdapter`                                                                                                                                                                                       | Dual-protocol gateway adapter                             |
| `normalizeBaseUrl`                                   | `(raw: string) => string`                                                                                                                                                                                        | Trim, drop trailing slashes, require http(s)              |
| `matchModelsDev`                                     | `(api: ModelsDevApi, id, hints?) => ModelsDevMatch[]`                                                                                                                                                            | Catalog lookup for a gateway id, official provider first  |
| `httpErrorCode`                                      | `(status: number, error?) => string`                                                                                                                                                                             | HTTP status → stable `LlmError` code                      |
| `serializeChatRequest` / `serializeResponsesRequest` | `(GenerateOptions) => ChatRequest \| ResponsesRequest`                                                                                                                                                           | Request serialization per protocol                        |
| `translateChat` / `translateResponses`               | `(payloads: AsyncIterable<string>) => AsyncGenerator<StreamChunk>`                                                                                                                                               | Wire → harness chunk translation                          |
| `parseSse`                                           | `(stream, onComment?) => AsyncGenerator<string>`                                                                                                                                                                 | SSE decoding                                              |
| Constants                                            | `DEFAULT_BASE_URL`, `DEFAULT_PROXY_URL`, `DEFAULT_CONTEXT_WINDOW` (128 000), `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (300 000), `DEFAULT_MODEL_EXCLUDE_PATTERNS`, `DEFAULT_PROVIDER_HINTS`, `MODELS_DEV_API_URL`, `PKG` | Adapter defaults                                          |

## Config

| Field                  | Type / default                                                   | Notes                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`              | `string` (fallback `$CARDO_BASE_URL` → default)                  | Gateway base incl. `/v1`                                                                                                                                                   |
| `api`                  | `'chat-completions' \| 'responses'` (default `chat-completions`) | Default protocol for un-pinned models                                                                                                                                      |
| `models`               | `CardoCatalogModel[]`                                            | Advisory catalog; per-row `id`, `name`, `description`, `contextWindow`, `maxTokens`, `api` (**per-model protocol override**), `reasoningEfforts`, `defaultReasoningEffort` |
| `modelExcludePatterns` | `string[]` (default `['embed','rerank','ranker']`)               | Substrings excluded from discovery                                                                                                                                         |
| `defaultContextWindow` | `number` (default 128000)                                        | Fallback when the model has no exact value                                                                                                                                 |
| `maxTokens`            | `number`?                                                        | Default per-request output cap                                                                                                                                             |
| `streamIdleTimeoutMs`  | `number` (default 300000)                                        | Idle watchdog budget                                                                                                                                                       |
| `proxy`                | `{ enabled, url }`                                               | Forward proxy for the models.dev download                                                                                                                                  |
| `providerHints`        | `{ defaults, models }`                                           | models.dev match-shaping hints                                                                                                                                             |
| `retryPolicy`          | schema                                                           | Provider-owned request retry policy                                                                                                                                        |

Protocol resolution: `protocolOf = models.find(id)?.api ?? connection.api` (`adapter.ts:342-345`).

## Data Flow (one LLM request)

1. Resolve facts per request: `config.options()`, API key via credentials seam (ref `cardo`), abort-signal union, idle watchdog.
2. Pick protocol by model (`protocolOf`).
3. Serialize: `serializeResponses(options)` or `serializeChat(options)` → JSON body.
4. HTTP POST `{baseURL}/chat/completions` or `{baseURL}/responses` (Bearer auth, `accept: text/event-stream`).
5. Parse SSE (`parseSse`); Chat stops at `[DONE]`, Responses passes terminal events through.
6. Translate back to harness `StreamChunk`s (block-start/delta/block-end/usage/finish).

models.dev lookup is NOT in the request path — it is an on-demand RPC from the settings page: `/llm-cardo` → `models-dev-params` → host downloads `https://models.dev/api.json` (via proxy if enabled) and maps per gateway id:

| models.dev field                          | Used as                  |
| ----------------------------------------- | ------------------------ |
| `entry.limit.context`                     | context window           |
| `entry.limit.output`                      | output tokens            |
| `entry.reasoning_options` (type `effort`) | reasoning-effort choices |

## Settings Page

Registered as `settings.section` slot (`id: 'cardo'`, order 15). Provides: API-key input (credentials seam), gateway base URL, default protocol select, model catalog editor (per-model context window / maxTokens / protocol override / default reasoning effort), "Fetch models" (discovers via `GET /models`, adopt-selected merges without overwriting tuned rows), proxy config, and a "Update model info" models.dev panel (overwrite-existing or fill-blank-only). Locale: zh (primary) + en.

## Wire Invariants (tested)

Locked by `test/reasoning-preservation.test.mjs` (per-shape regressions + seeded randomized properties, 300 runs):

- Every non-empty reasoning/text/tool-call fragment the wire emits reaches the harness — **no loss, no duplication** — across every wire shape real gateways use.
- Shapes covered — Chat: `delta.reasoning_content` (DeepSeek/Qwen/GLM), `delta.reasoning` (OpenRouter), terminal `message.reasoning_content/reasoning/content/tool_calls` replay (DashScope/buffered), with no duplication of already-streamed deltas. Responses: `reasoning_summary_text.delta`, complete `reasoning` items, `content_part` reasoning parts, `response.completed/incomplete` output arrays, `reasoning_summary_part.done`, buffered `function_call`, with no duplication.
- Agent-loop round-trip (Responses): every assistant turn's reasoning serializes as a `reasoning` item (`content` + `summary` — OpenAI requires `summary`, DeepSeek merges `content`), emitted BEFORE `function_call` items on tool-call turns because DeepSeek's Responses API in thinking mode rejects a multi-turn tool-call continuation without the prior turn's `reasoning_text` — and rejects EMPTY reasoning items too, so a tool-call turn whose answer had no (or empty) reasoning carries the conversation's most recent actual chain of thought forward.
- Agent-loop round-trip (Chat): an assistant message with a reasoning block replays `reasoning_content` verbatim; once reasoning appeared anywhere in the conversation, every later tool-call turn carries the field too — reasoningless turns round-trip as the empty marker `""` (DeepSeek's thinking mode is all-or-nothing: a tool-call turn missing the field fails the next request with "The `reasoning_content` in the thinking mode must be passed back to the API").

Other locked behaviors: empty tool output → `'(no output)'`; text-less turns send `""` never `null`; `stream_options.include_usage: true` / `store: false`; cache-hit tokens subtracted for disjoint `inputTokens`; image content rejected (`UNSUPPORTED_CONTENT`).

## Build / Packaging

- Host: esbuild `lib/index.js` (ESM, node22) — `eventsource-parser` + `undici` inlined, `@deepseek-ai/*`/`cordis`/`schemastery`/`react` external; `createRequire` banner for inlined CJS undici; `.ts` → `.js` specifier rewrite in the `.d.ts` emit.
- Client: esbuild `lib/client.js` (CJS, browser, es2022) wrapped as `window.__ModuleLoader__.load({ id: '@cardo/cardo-provider', factory })`.
- Profile provisioning copies `package.json` + `lib/` + `cordis.patch.yml` — no pnpm install (self-contained).

## Dependencies

- Outbound (peers, all exact `@deepseek-ai/*@0.1.0-rc.6` + cordis 4.0.1): dsh-llm, dsh-credentials, dsh-settings, dsh-launch-environment, dsh-timeout, dsh-client-* (client half); schemastery, react.
- Runtime deps: eventsource-parser, undici (inlined at build).
- Inbound: `packages/cardo-desktop` provisions it as `BUILTIN_WORKSPACE_PLUGINS`.

## Patterns & Gotchas

- Proxy must ride undici's own `fetch` — Node's global fetch brand-checks `dispatcher` and rejects an npm-minted `ProxyAgent` (`adapter.ts:492-499`).
- Last-good config retained when a settings edit is invalid — a bad edit never breaks the next request.
- Retry-policy change re-registers the route in place (the one registration-captured fact).
- API key only via the credentials seam, never env (`MISSING_CREDENTIAL` otherwise).

## How to Update

- New wire shape supported → extend the translator + add a per-shape regression + seeded property in `test/reasoning-preservation.test.mjs`.
- Reasoning-passback rule changed → update the deterministic agent-loop cases and the seeded serialize properties in the same file (the suite locks no-loss/no-duplication AND the thinking-mode passback).
- Config field added → update `Config` schema, the settings page, and this file's Config table.
- Source changed → run `pnpm run build` — the desktop provisions the built `lib/`; a stale bundle ships a stale plugin.

## Find It Fast

```bash
grep -n 'protocolOf' packages/cardo-provider/src/adapter.ts          # per-model protocol routing
grep -n 'no loss\|no duplication' packages/cardo-provider/README.md   # invariant statement
```
