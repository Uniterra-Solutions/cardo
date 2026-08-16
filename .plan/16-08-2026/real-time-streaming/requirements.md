# Real-time streaming delivery — refactor requirements

Date: 2026-08-16. Target: `vendor/pi-gui/apps/desktop` + vendored driver packages.

## Goal

後端數據實時傳輸到前端：任何長任務（數千到數萬 driver events）下，前端顯示不落後、UI 不被阻塞。業務契約由 PBT 不變量鎖定（見下），重構的驗收 = 讓紅的不變量轉綠、保持綠的不變量仍綠。

## Reported bug (recurring, multiple failed fixes)

"只要發給 agent 一個長任務，前端就一直落後於後端，並且完全無法操作前端其他功能。" Main-process saturation: 每 event 的 store 成本隨累積 transcript 增長 → 總成本 O(N²) → IPC round-trip（點 sidebar / 切 session）全卡住，推送排隊 → 顯示落後。

## Investigation evidence (2026-08-16)

1. **已修（本次 session）**：`electron/app-store-session-state.ts` `applySessionEventState` 每 event 都 `.map(cloneTranscriptMessage)` 深拷貝整份 transcript，只用於唯讀計算（preview / hasUnseenSessionUpdate）。Benchmark（真實 store 模組，3000 events）：45.7 → 3.0 µs/event（15×）。已由 PBT K + unit 鎖住（revert-verify 過）。
2. **殘餘（重構 target）**：`electron/app-store-timeline.ts` 每個 mutation 都 `[...transcript]` 重建整個陣列（O(items)/event）+ `findIndex` 掃描 + `appendAssistantDelta` 字串 concat（O(message²)）。Benchmark：per-event 成本仍隨 n 增長（2.0 → 3.0 µs over 6× events）。
3. **State push 全量**：`main.ts` `publishStateToWindow` 每 80ms `structuredClone(整個 DesktopAppState)`（`projectStateForView` line 312）+ IPC 再序列化 + renderer `setSnapshot(incoming)` 整棵替換 → 全量 re-render。`orchestrationChildren`（含完整子線程 transcript）寄生在全量 state 裡。
4. Transcript 已走 delta 通道（`pi-gui:transcript-delta`，`src/transcript-delta.ts`），coalescing 鎖 push 次數（`electron/stream-publish.ts`）——這些是「已修好的部分」，重構必須保持。

## Business invariants (PBT — the contract)

`vendor/pi-gui/apps/desktop/test/pbt/store-liveness.test.mts`（新增）+ 既有 `streaming-sync.test.mts` / `transcript-delta.test.mts`：

- **K**（綠，已鎖）：`applySessionEventState` fold 不得對 transcript 做 full-array 拷貝 pass（Proxy 偵測 `.map/.filter/.slice/...`，0 次）。
- **K′**（紅，重構 target）：完整 fold 路徑（含 timeline mutations）的陣列重建成本必須線性——Σ rebuilt.length ≤ 64 × events。目前 `[...transcript]` 每 event 拷貝整個陣列 → 紅。
- **J**（綠，護欄）：content-unchanged items 跨 fold 保持 object identity（delta diff 與 renderer memo 的 `===` 契約）。重構不得破壞。
- 既有 A–D（streaming-sync）：content accounting / identity / payload monotonicity / coalesced liveness。
- 既有 E–J（transcript-delta）：convergence / no-loss / delivery decision / reference stability——renderer 端契約。

## Design direction

**A. Store 持久化 transcript 結構（K′ → 綠）**：`app-store-timeline.ts` 的 transcript cache 從「每 mutation 重建整個陣列」改為持久化結構（head/tail 或 chunked persistent list）：

- 已定稿 items 保持不可變 + identity 穩定（J 要求）
- 每個 mutation 只重建最後的 tail/chunk（O(chunk)，bounded constant）
- 對外仍提供 `readonly TranscriptMessage[]`（消費者需要完整陣列時物化，O(n) 一次——受 80ms coalescing 限制，不是 per-event）
- active message text 改存 parts list，定稿/物化時才 join（消掉 O(text²) concat）
- 必須保持：所有讀取 `transcriptCache.get(key)` 的消費者行為不變（見 downstream）

**B. State snapshot + delta（跟 transcript delta 同一模式）**：`main.ts` publish path：

- 移除 `projectStateForView` 的 `structuredClone(state)`（IPC 序列化已做一次，clone 是純浪費）
- session switch / 首次 push → 全量；之後 → 只推變更的 slices（新純模組 `src/state-delta.ts`：`decideStateDelivery` / `computeStateDelta` / `applyStateDelta`，比照 transcript-delta）
- `orchestrationChildren`（完整子線程 transcript + evidence）從 per-push 全量拆出（自己的 delta 或 on-demand），不得寄生在 state push

**C. Renderer state delta 應用**：`src/app/desktop-app-state.ts` 接收 state ops 本地應用，未變 slice 保 identity → memo 短路。與 transcript delta 的 `applyTranscriptDelta` 同模式。

## Downstream consumers (must not break)

- `transcriptCache`（`Map<string, TranscriptMessage[]>`）讀者：`app-store.ts`（`handleSessionEvent`、`getSelectedTranscriptItemsForView`、`buildSelectedTranscriptRecord`）、`app-store-session-state.ts`（唯讀）、`app-store-persistence.ts`（序列化）、PBT 模組。任何結構變更必須維持這些讀者拿到的陣列語義（id/kind/text/… 不變）。
- `DesktopAppState` 消費者：renderer 全域（`App.tsx`、sidebar、composer、extension UI）、多窗口 projection（`main.ts` view/`projectStateForView`）、持久化。State delta 不能改變 renderer 讀到的最終 state 內容。
- `pi-gui:state-changed` / `pi-gui:selected-transcript-changed` / `pi-gui:transcript-delta` channels：協定不變（除新增 state delta channel）。
- PBT 編譯範圍：`tsconfig.pbt.json` include 需加入新純模組（如 `src/state-delta.ts`）。

## Constraints

- 所有 vendored 變更需 `// Cardo:` marker。
- 不做 transport 變更（in-process IPC 已夠快；瓶頸是 payload 大小與 per-event 成本）。
- PBT 驗收：`pnpm --filter @pi-gui/desktop test:pbt`。e2e 需要 `pnpm --filter @pi-gui/desktop build`。
- 平行 workers 不得跑 `build`（共享 `out/`）；orchestrator 統一 build。
- 每步先寫/改測試（tests travel with implementation），revert-verify 確認測試真的抓回歸。

## Verification lanes

- PBT: `pnpm --filter @pi-gui/desktop test:pbt`（K′ 轉綠、K/J/A–J 保持綠、3 次連續跑穩定）
- Typecheck: `pnpm --filter @pi-gui/desktop typecheck`; lint: `pnpm run lint`
- e2e: `tests/core/transcript-staleness.spec.ts` + `tests/live/extensions-dialogs.spec.ts`（transcript delta + 現有對話流）
- Benchmark（可選）：store fold per-event 成本隨 n 不再增長（3000 events < 4µs/event）
