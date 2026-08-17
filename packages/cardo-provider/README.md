# @cardo/cardo-provider

卡多自家雙協定 LLM provider 插件（DeepSeek Harness）。以 **workspace 內建**方式由 `packages/cardo-desktop` 拷貝進 profile（見 `builtin.ts` 的 `BUILTIN_WORKSPACE_PLUGINS`）。

## 能力

- **雙協定**：OpenAI chat completions（`/chat/completions`）與 Responses API（`/responses`，SSE）—— 任何 OpenAI-compatible gateway 皆可使用；協定可逐模型覆寫（`api: 'chat-completions' | 'responses'`）
- **models.dev 自動偵測**：context window / max output tokens / reasoning efforts 自動比對填入，Web 設定頁一鍵拉取
- **Web 設定頁**：新增 gateway（base URL + API key）、逐模型管理、proxy 支援（undici `ProxyAgent`）

## Wire 格式與 reasoning 保留

雙協定對 reasoning 的處理守同一條不變量：**wire 發出的任何非空 reasoning fragment 都必須進 harness 的 `reasoning` block，歷史回合的 reasoning 也必須回傳網關——無遺失、無重複**。

- **Chat Completions 接收**：`delta.reasoning_content`（DeepSeek/Qwen/GLM）、`delta.reasoning`（OpenRouter 等聚合器）、終止 chunk 的 `message.reasoning_content` / `message.reasoning` 全量回放（DashScope compatible mode）——回放只在沒有 delta 時補上，避免重複
- **Chat Completions 回傳**：工具回合的 assistant message 攜帶 `reasoning_content`（DeepSeek 硬性要求）
- **Responses 接收**：`response.reasoning_text.delta/.done`、`response.reasoning_summary_text.delta/.done`、`reasoning` output item（`content` / `summary`）、`content_part.*` 的 `reasoning_text` part、`response.completed` / `response.incomplete` 的 `response.output` 兜底——同一 item 已流式 delta 則跳過整段回放
- **Responses 回傳**：非工具回合在 assistant message 前插入 `reasoning` item（`content` + `summary` 同發；OpenAI 要求 `summary`，DeepSeek 合併 `content`）
- **測試**：`test/reasoning-preservation.test.mjs` — 逐 wire shape 回歸 + seeded 隨機 property（300 輪隨機交錯，鎖定無遺失、無重複）

## 開發

```bash
pnpm --filter @cardo/cardo-provider run build       # tsc (types) + esbuild host+client bundle → lib/
pnpm --filter @cardo/cardo-provider test            # build + node:test 組合/雙協定 translate 測試
pnpm --filter @cardo/cardo-provider run lint        # eslint src
pnpm --filter @cardo/cardo-provider run typecheck   # host + client 兩個 tsconfig
```

改動 `src/` 後記得 `pnpm run build`：desktop 的 workspace 內建 provision 拷貝的是 `lib/`（build 產物），stale `lib/` 會讓 profile 帶著舊版插件。

## Build 產物佈局

- `lib/index.js` — host bundle（ESM，自包含：runtime deps 內聯，僅 `@deepseek-ai/*` peers external）
- `lib/client.js` — browser bundle（CJS closure-factory，dsh client module loader 載入）
- `lib/types/` — tsc declaration emit（`.d.ts` 的 `.ts` specifier 已改寫為 `.js`）

## 設定

命名空間 `llm-cardo`；provider id `cardo`。註冊的 gateway 走 `ctx.llm.registerConfigurableProvider`，models.dev 偵測走 `registerModelDiscovery`。API key 存於 cardo credentials。
