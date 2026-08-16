# Cardo

統一桌面工作台 —— 整合 Uniterra 的 Hermes 插件（Jovaltus、Caelterra、Tabularius、Fabricium）於單一 surface，作為全公司 agent 運作的標準基準點。Built on the DeepSeek Harness (dsh) agent runtime; company knowledge ships as bundled skills.

**文檔：[Documentation](docs/README.md)**（架構圖、模組深潛、設定、測試、工作流）· **規範：[AGENTS.md](AGENTS.md)**

## Packages

| Package                       | 說明                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cardo-desktop`      | Electron shell over the bundled dsh CLI。啟動時確保公司內建（`src/builtin.ts`：10 個 npm 插件 + 5 個 vendored 插件 + 1 個自家 workspace 插件）進 profile；公司技能經 `DSH_BUNDLED_SKILL_DIR` 掛載。packaged 時從 `Contents/Resources/src` 解析全部資源，dev 從 monorepo |
| `packages/cardo-provider`     | 自家雙協定 LLM provider 插件（`@cardo/cardo-provider`）：OpenAI chat completions + Responses API，任何 OpenAI-compatible gateway 皆可；models.dev context/output-token 自動偵測 + Web 設定頁。以 workspace 內建方式拷貝進 profile（build 產物自包含，零 pnpm install）  |
| `packages/cardo-cli`          | 公開 npm 安裝器（`@uniterra-solutions/cardo`，bin `cardo`）：一鍵 macOS 安裝/更新。`cardo setup` 下載 release 原始碼 tarball → install → build → electron-builder → 安裝到 `~/Applications`；`cardo update` 只更新 CLI                                                  |
| `packages/cardo-skills`       | 內建技能註冊表：公司標準技能（cardo-planmode、cardo-pbt-debugging、qa、project-documentation、create-skill、manage-agents-md、manage-git-repo）build 時複製到 `dist/skills/`，啟動時冪等 provision                                                                      |
| `packages/cardo-systemprompt` | pi-agent 延伸：app 全域工作規則（no emoji、簡潔回覆、不過度工程化、最小程式碼、驗證外部 API、依業務邏輯加測試、以使用者語言回覆）經 `before_agent_start` 附加到每個 agent turn                                                                                          |
| `vendor/dsh-plugins/`         | 固定 commit 的 dsh 社群插件（未發佈到 npm）；見 `VENDOR.md` pin ledger                                                                                                                                                                                                  |

## 開發

```bash
pnpm install              # 安裝依賴（自動啟用 husky pre-commit hooks）
pnpm lint                 # ESLint（strictTypeChecked + 額外 strict 規則）
pnpm typecheck            # tsc -b --noEmit
pnpm format               # Prettier 格式化
pnpm build                # tsc -b（全 workspace）+ skills copy

# 個別 package 驗證
pnpm --filter @cardo/cardo-desktop test     # profile bootstrap + built-ins/readiness PBT
pnpm --filter @cardo/cardo-provider test    # provider 組合 + 雙協定 translate 測試
pnpm --filter @cardo/cardo-cli test         # CLI 單元測試 + install-logic PBT
pnpm --filter @cardo/cardo-skills test      # skills provisioning 測試
```

## Pre-commit Hooks

`.husky/pre-commit` 執行 `lint-staged`：

- `*.{ts,tsx}` → `prettier --write` + `eslint --fix --max-warnings 0`
- `*.{json,md,yaml,yml}` → `prettier --write`

任何 ESLint warning/error 都會阻止 commit（`--max-warnings 0`）。

## 慣例（與 Uniterra 其他 TS repo 一致）

- Node ≥ 22（`.nvmrc` / `engines` 鎖定）
- NodeNext ESM：內部 import 必須帶 `.js` 後綴
- 只准 named exports，禁止 default exports（單一例外：`packages/cardo-systemprompt/src/index.ts` 的 pi loader factory）
- 禁止 `any`（`no-explicit-any: error`）
- dsh migration：`@deepseek-ai/*` 依賴鎖定精確版本（無 caret）
- 桌面 app 消費的 `@cardo/*` 套件 exports 指向 built `dist`（例外：`@cardo/cardo-provider` 的 esbuild bundle 在 `lib/`）
- 詳細見 `AGENTS.md`
