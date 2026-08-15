# Cardo

統一桌面工作台 —— 整合 Uniterra 的 Hermes 插件（Jovaltus、Caelterra、Tabularius、Fabricium）於單一 surface，作為全公司 agent 運作的標準基準點。Built on the pi-agent core; plugins live as separate workspace packages.

**文檔：[Documentation](docs/README.md)**（架構圖、模組深潛、設定、測試、工作流）

## Packages

| Package             | 說明                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/jovaltus` | Jovaltus plan-mode pipeline（plan → clarify → design → 失敗 PBT spec → execution-plan.json → execute_plan）作為 pi-agent extension。CLI 安裝：`pi install ./packages/jovaltus` 或 `pi -e packages/jovaltus/src/index.ts`；桌面 app 以內建 extension 載入（經 `packages/runtime`） |
| `packages/runtime`  | 桌面 runtime：內建 extension registry（`builtinExtensionFactories` + `builtinExtensionMetadata`），被 vendored desktop app 消費                                                                                                                                                   |
| `vendor/pi-gui`     | git-subtree 管理的桌面 app（MIT，pi-gui v0.1.0-beta.33）：Electron shell + `@pi-gui/*` driver 套件；pi-coding-agent 對齊 0.84.1                                                                                                                                                   |

## 開發

```bash
pnpm install        # 安裝依賴（自動啟用 husky pre-commit hooks）
pnpm lint           # ESLint（strictTypeChecked + 額外 strict 規則）
pnpm typecheck      # tsc -b --noEmit
pnpm format         # Prettier 格式化
pnpm build          # tsc -b（jovaltus + runtime → dist）

# 桌面 app（vendored pi-gui）
pnpm --filter @pi-gui/desktop dev       # 開發模式（Electron + watch）
pnpm --filter @pi-gui/desktop build     # production electron-vite build
```

## Pre-commit Hooks

`.husky/pre-commit` 執行 `lint-staged`：

- `*.{ts,tsx}` → `prettier --write` + `eslint --fix --max-warnings 0`
- `*.{json,md,yaml,yml}` → `prettier --write`

任何 ESLint warning/error 都會阻止 commit（`--max-warnings 0`）。

## 慣例（與 Uniterra 其他 TS repo 一致）

- Node ≥ 22（`.nvmrc` / `engines` 鎖定）
- NodeNext ESM：內部 import 必須帶 `.js` 後綴
- 只准 named exports，禁止 default exports（單一例外：`packages/jovaltus/src/index.ts` 的 pi loader factory）
- 禁止 `any`（`no-explicit-any: error`）
- `vendor/` 由 git subtree 管理——cardo 側只做最小、帶 `// Cardo:` 註解的修改；更新走 `git subtree pull`
- 桌面 app 消費的 `@cardo/*` 套件 exports 指向 built `dist`（Node 不能直接載 TS source）
- 詳細見 `AGENTS.md`
