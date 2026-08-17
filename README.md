# Cardo

基於 DeepSeek Harness（dsh）agent runtime 與社群 dsh 插件構建的桌面 app：Electron shell 啟動內建 dsh CLI、把內建插件與技能 provision 進使用者 profile，並在視窗中託管 dsh Web UI。**目標是讓用戶通過插件快速構建自己的桌面 agent app** —— 內建 9 個 npm 社群插件、2 個 vendored 社群插件、1 個自家 provider 插件，用戶可隨時再加裝更多。

**文檔：[Documentation](docs/README.md)**（架構圖、模組深潛、設定、測試、工作流）· **規範：[AGENTS.md](AGENTS.md)**

## 內建工作流

| 工作流                                                                                     | 說明                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TDD 開發工作流**（`cardo-plan` → `cardo-implement` → `cardo-simplify` / `cardo-review`） | 計畫 → 澄清 → PRD/設計 → execution-plan.json（每任務明確需求清單）→ 實作：簡單任務直接寫失敗屬性測試再改代碼；複雜任務先寫全部失敗屬性測試，再按任務重疊度以 dynamic workflow 批次/全平行執行 → 依明確審查範圍簡化/審查。整合屬性測試在開發期就把已知不變量會帶來的 bug 全部擋下 |
| **TDD 除錯工作流**（`cardo-pbt-debugging`）                                                | 先不改程式：引導 agent 閱讀項目業務邏輯、把業務邏輯設定為不變量、用屬性測試重現 bug（必須失敗，反例即重現）→ 修根因 → 回歸測試鎖定。把 debug 簡化為機器搜索問題，最大化 AI agent 修復軟體錯誤的能力                                                                              |
| **項目文檔管理**（`project-documentation` 等）                                             | 結構化 `docs/` 樹生成與增量更新；另有 QA 驗收（`cardo-qa`）、技能建立（`create-skill`）、AGENTS.md 管理（`manage-agents-md`）、git 流程（`manage-git-repo`）                                                                                                                     |

工作流細節：[docs/modules/cardo-skills.md](docs/modules/cardo-skills.md) · 常用任務配方：[docs/workflows.md](docs/workflows.md)

## 內建 Provider 增強

`@cardo/cardo-provider`：雙協定（OpenAI chat completions + Responses API）LLM provider 插件，可自由配置任何 OpenAI-compatible 外部 provider，並透過 models.dev 自動取得上游模型資訊（context window / output tokens / reasoning efforts），Web 設定頁管理 gateway 與逐模型協定覆寫。詳見 [docs/modules/cardo-provider.md](docs/modules/cardo-provider.md)。

## 快速開始

```bash
# 安裝 app（macOS / Windows 10+）
npm install -g @uniterra-solutions/cardo
cardo setup
# macOS → ~/Applications/Cardo.app；Windows → %LOCALAPPDATA%\Programs\Cardo（附開始功能表捷徑）
cardo update
# 一鍵更新：刷新 CLI + 重建重裝 app + 自動重啟（app 內的 Update Now 也會跑這條指令）

# 開發
git clone https://github.com/Uniterra-Solutions/cardo.git
cd cardo
pnpm install --frozen-lockfile
pnpm build && pnpm lint && pnpm typecheck
pnpm --filter @cardo/cardo-desktop dev    # dev 模式（不碰真實 ~/.dsh）
```

測試指令與驗證矩陣：[docs/testing.md](docs/testing.md) · 環境變數：[docs/setup.md](docs/setup.md)

## 技術棧

Node ≥ 22 · Electron 37 · @deepseek-ai/dsh 0.1.0-rc.6（精確鎖版）· TypeScript ~5.9（NodeNext ESM）· pnpm 11 · fast-check（PBT）· esbuild / electron-builder。完整清單：[docs/tech-stack.md](docs/tech-stack.md)

## 慣例

NodeNext ESM（內部 import 帶 `.js` 後綴）· 只准 named exports · 禁 `any` · `@deepseek-ai/*` 精確鎖版 · 每個業務邏輯都有測試。詳見 [AGENTS.md](AGENTS.md) 與 [docs/conventions.md](docs/conventions.md)。

## License

[MIT](LICENSE)
