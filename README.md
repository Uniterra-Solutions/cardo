# Cardo

統一桌面工作台 —— 整合 Uniterra 的 Hermes 插件（Jovaltus、Caelterra、Tabularius、Fabricium）於單一 surface，作為全公司 agent 運作的標準基準點。

## 開發

```bash
pnpm install        # 安裝依賴（自動啟用 husky pre-commit hooks）
pnpm lint           # ESLint（strictTypeChecked + 額外 strict 規則）
pnpm typecheck      # tsc -b --noEmit
pnpm format         # Prettier 格式化
pnpm build          # tsc -b
```

## Pre-commit Hooks

`.husky/pre-commit` 執行 `lint-staged`：

- `*.{ts,tsx}` → `prettier --write` + `eslint --fix --max-warnings 0`
- `*.{json,md,yaml,yml}` → `prettier --write`

任何 ESLint warning/error 都會阻止 commit（`--max-warnings 0`）。

## 慣例（與 Uniterra 其他 TS repo 一致）

- Node ≥ 22（`.nvmrc` / `engines` 鎖定）
- NodeNext ESM：內部 import 必須帶 `.js` 後綴
- 只准 named exports，禁止 default exports
- 禁止 `any`（`no-explicit-any: error`）
- 詳細見 `AGENTS.md`
