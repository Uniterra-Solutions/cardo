# Module: cardo-provider (`packages/cardo-provider/`)

**Purpose:** In-house dual-protocol LLM provider plugin (`@cardo/cardo-provider`): OpenAI Chat Completions **and** Responses API over any OpenAI-compatible gateway, with models.dev context/output/reasoning-effort auto-detection and a Web settings page. Ships as a workspace built-in; the desktop provisions the built `lib/` into the dsh profile (see `BUILTIN_WORKSPACE_PLUGINS` / `workspacePluginsStale()` in `packages/cardo-desktop/src/builtin.ts`).

Sources: `src/adapter.ts` (routing, discovery, error mapping), `src/serialize-chat.ts` + `src/serialize-response.ts` (request builders), `src/translate-chat.ts` + `src/translate-response.ts` (SSE → `StreamChunk`), `src/types.ts` (wire types), `src/sse.ts` (protocol-neutral SSE framing), `src/index.ts` (plugin registration).

## Protocol selection

| Field                           | Meaning                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| connection-level `api`          | Default wire protocol for models that do not pin one                          |
| per-model catalog row `api`     | Overrides the connection default (`'chat-completions' \| 'responses'`)        |
| `protocolOf(connection, model)` | Resolves the per-request protocol; selects serializer + endpoint + translator |

| Protocol           | Endpoint                     | Terminal condition                                               |
| ------------------ | ---------------------------- | ---------------------------------------------------------------- |
| `chat-completions` | `{baseURL}/chat/completions` | `[DONE]` SSE sentinel                                            |
| `responses`        | `{baseURL}/responses`        | `response.completed` / `response.incomplete` / `response.failed` |

## Reasoning preservation invariant

One invariant rules both translators: **every non-empty reasoning fragment the wire emits reaches a harness `reasoning` block exactly once, and previous turns' reasoning is replayed on the wire**. Loss and duplication are both violations; the randomized property tests generate arbitrary interleavings of every shape below and assert the translated blocks equal the wire content exactly.

### Chat Completions — consumed shapes

| Shape                                                                            | Gateway                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------- |
| `delta.reasoning_content`                                                        | DeepSeek, Qwen, GLM                          |
| `delta.reasoning`                                                                | OpenRouter and aggregator gateways           |
| `message.reasoning_content` / `message.reasoning` (terminal chunk, empty deltas) | DashScope compatible mode (full-text replay) |
| `message.content` / `message.tool_calls` (terminal chunk, empty deltas)          | buffered gateways                            |

Dedup rule: each replay is appended only when nothing of that kind streamed via deltas (`sawDeltaReasoning` / `sawDeltaText` / per-index tool-call blocks). A reasoning replay with no streamed deltas is presented **before** the answer text block.

### Responses API — consumed shapes

| Shape                                                                              | Gateway                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `response.reasoning_text.delta` / `.done`                                          | DeepSeek Responses, OpenAI (`include` path) |
| `response.reasoning_summary_text.delta` / `.done`                                  | OpenAI o-series (default summary streaming) |
| `response.reasoning_summary_part.done`                                             | summary delivered as a completed part       |
| `response.output_item.done` with a `reasoning` item (`content` + `summary` parts)  | whole-item delivery, no deltas              |
| `response.content_part.added` / `.done` with `reasoning_text` parts                | part-framed reasoning                       |
| `response.completed` / `response.incomplete` `response.output` array               | authoritative terminal fallback             |
| `response.output_text.done`, `content_part.done` `output_text` part, message items | text equivalents (same no-loss/no-dup rule) |

Dedup rule: item ids that already streamed incrementally (`streamedReasoning` / `streamedText` sets) skip any whole-item or done-event replay.

### Round-trip (agent loop)

- Chat: assistant messages on tool-call turns replay `reasoning_content` (DeepSeek rejects tool-call turns without it). Non-tool turns deliberately omit it — DeepSeek does not require it and strict-gateway tolerance of the extension field is unverified.
- Responses: assistant messages without tool calls emit a `reasoning` input item (`content` + `summary`) before the message — OpenAI requires `summary` on input reasoning items; DeepSeek merges plain-text `content` into the adjacent assistant message and ignores `summary`.

## Tests

- `test/smoke.test.mjs` — plugin composition through cordis, dual-protocol serialize/translate, discovery, credentials, settings validation, models.dev matching.
- `test/reasoning-preservation.test.mjs` — one deterministic regression per wire shape plus two seeded randomized properties (chat + responses, 300 runs each) asserting no loss and no duplication.

## Dependencies

- Inbound: `packages/cardo-desktop/src/builtin.ts` (provisioning), harness `ctx.llm` registration.
- Outbound: `@deepseek-ai/dsh-llm` (adapter base, `StreamChunk` vocabulary), `@deepseek-ai/dsh-timeout` (idle watchdog), `undici` (proxy `ProxyAgent` for the models.dev download), `eventsource-parser` (SSE framing). Runtime deps are inlined by esbuild; only `@deepseek-ai/*` peers stay external.
