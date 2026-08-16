# Debug Mode — Design Document

## 1. Summary

Debug mode is implemented as a **third value of the existing per-session mode
registry** (`standard | plan | debug`) inside `packages/jovaltus`, alongside
the established plan-mode machinery in `src/plan-mode.ts`. It follows plan
mode's exact patterns — `/debugmode` runtime command, `debug-mode` start flag,
`pi.appendEntry` persistence under the existing `jovaltus-mode` custom entry
type (now writing a single `{ mode }` value with a legacy `{ enabled }` read
fallback), `ctx.ui.setStatus` under the existing `jovaltus-mode` status key
(now carrying `'standard' | 'plan mode' | 'debug mode'`), and a
`before_agent_start` system-prompt append gated on debug being active. The
desktop reuses its existing jovaltus mode surfaces: the composer mode button
becomes a three-state cycle (standard → plan → debug → standard) and the
new-thread picker gains a third option. The pure mode business logic (cycle,
status-text bijection, persistence round-trip, tool-set transitions, restore
precedence, prompt append) is extracted into a new `src/mode.ts` module so the
failing property-based tests can be written before the implementation.

**Why in `packages/jovaltus` and not a new `packages/debug`:** FR-1 requires
plan and debug to be mutually exclusive _in the same in-process state_ (one
active non-standard mode, tool-set changes coordinated in the same
invocation). Two separate extension closures cannot coordinate exclusivity
without a new shared mode-core package, shared registrations, and desktop-side
reconciliation of two statuses — strictly more machinery. The PRD's A1
standalone-package default is explicitly subject to the design doc selecting
the minimal-change path; in-jovaltus is that path. `packages/jovaltus` already
owns plan mode (a non-pipeline, per-session agent-behavior feature) and the
desktop mode UI lives in `jovaltus-ui.tsx`, so this does not broaden the
package's scope in a new way.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Placement:** debug mode lives in `packages/jovaltus` (extends `src/plan-mode.ts` + new pure `src/mode.ts`), **not** a new `packages/debug` package.                                                                                                                                                                                                 | FR-1 exclusivity needs one shared in-process registry; two extension closures can't coordinate without a new shared package + desktop reconciliation. Fewest new modules (AGENTS.md: minimal code). |
| D2  | **Exclusivity:** one per-session mode, exactly `standard \| plan \| debug`; at most one non-standard mode (FR-1/A2). `/planmode` forces `plan` (from standard or debug); `/debugmode` forces `debug` (from standard or plan).                                                                                                                         | Matches PRD FR-1; each command is a self-activating toggle of its own mode, symmetric and predictable.                                                                                              |
| D3  | **Status key:** reuse `jovaltus-mode` with three texts `'standard' \| 'plan mode' \| 'debug mode'` (A6 option 1).                                                                                                                                                                                                                                     | Single source of truth; the key is already excluded from the generic extension dock (`CUSTOM_RENDERED_STATUS_KEYS`), so FR-11 is satisfied with **zero** desktop dock changes.                      |
| D4  | **Persistence:** keep entry type `jovaltus-mode`, write `{ mode: CardoMode }`; read with legacy fallback: `{ mode }` wins, else `{ enabled: true }` → plan, `{ enabled: false }`/missing → standard (A7 read-compat).                                                                                                                                 | Existing sessions restore exactly as today (A7 behavior); one atomic three-value field can't represent the forbidden both-active state.                                                             |
| D5  | **Desktop surface:** full UI — composer button cycles standard → plan → debug → standard (button + shift+tab), new-thread picker gains a third option (A3/FR-8/FR-10).                                                                                                                                                                                | PRD requires starting a thread already in debug mode; command-only would not satisfy FR-10.                                                                                                         |
| D6  | **Desktop command mapping:** button computes next mode via the cycle, then submits `/planmode` (standard→plan), `/debugmode` (plan→debug), `/debugmode` (debug→standard) through the existing guarded runtime slash-command path (`resolveRuntimeSlashCommand` + `submitComposer`).                                                                   | Reuses the exact plan-mode toggle path (silent, no optimistic row — FR-9 comes free via `app-store-composer.ts` `suppressOptimisticMessage`).                                                       |
| D7  | **TUI surface:** `/debugmode` command only; no new shortcut (A4/FR-13; shift+P stays plan-only).                                                                                                                                                                                                                                                      | PRD non-goal; shift+tab is `app.thinking.cycle`.                                                                                                                                                    |
| D8  | **Startup flag:** `debug-mode` boolean flag, default `false`; on `session_start` the persisted mode wins over the flag, the flag wins over nothing, default `standard` (mirrors plan-mode's current flag-vs-entry precedence — Open Q6 default).                                                                                                      | Behavior parity with plan mode; documented in FR-3/FR-4.                                                                                                                                            |
| D9  | **No tool changes:** debug adds/removes no tools and touches no `tool_call` gate (FR-12). `applyModeTools` for `standard`/`debug` yields the pre-plan tool set minus plan tools; entering `plan` re-captures the base if needed (preserving the existing `toolsBeforePlanMode` restore).                                                              | Non-goal in PRD; the shared registry keeps the existing restore semantics.                                                                                                                          |
| D10 | **Prompt append:** the debug note is a separate `before_agent_start` handler (mirroring `packages/general`'s append handler pattern, FR-6), registered alongside plan mode's note handler; exactly one of the two notes can be present because the registry is exclusive.                                                                             | FR-6/FR-7; deterministic, base-prefix-preserving, no cross-turn duplication.                                                                                                                        |
| D11 | **Pure core extraction:** new `src/mode.ts` holds the mode business logic as pure functions; `src/plan-mode.ts` becomes the pi wiring.                                                                                                                                                                                                                | This is the PBT surface (FR-14): tests lock pure functions + extension-level sequences via the existing stub harness.                                                                               |
| D12 | **Desktop PBT:** no changes to the desktop `test:pbt` suite. Mode classification/cycle is thin UI glue on a status text; the established jovaltus contract coverage is the Playwright live specs (there are zero jovaltus items in the desktop PBT today). FR-15's "where applicable" is met by updating/extending the two existing Playwright specs. | Avoids pulling React components into `out-pbt` for a 3-way string switch.                                                                                                                           |
| D13 | **Existing spec updates:** `plan-mode.test.mts` entry-shape assertions (`{ enabled }` → `{ mode }`) and the two Playwright specs' binary toggling expectations are updated to the three-mode cycle.                                                                                                                                                   | Representation change (D4) and UI change (D5) necessarily touch existing contract assertions; behavior intent is preserved.                                                                         |

## 3. Architecture

### 3.1 Packages (unchanged boundaries)

- `packages/jovaltus` — owns the mode registry (plan + debug). Entry stays a
  default-exported factory; `packages/runtime` and `packages/general` are
  **untouched**.
- Desktop (`vendor/pi-gui/apps/desktop`) — mode UI changes, all marked
  `// Cardo:`; vendored code edits stay minimal.

### 3.2 `packages/jovaltus` module layout

**`src/mode.ts` (new, pure — no pi imports, named exports only):**

```ts
export type CardoMode = 'standard' | 'plan' | 'debug';
```

Pure functions and constants (the full business-logic surface, §5):

| Symbol                                   | Purpose                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MODE_CYCLE`                             | `['standard', 'plan', 'debug']` — fixed cycle order (FR-8).                                                         |
| `nextMode(mode)`                         | Cycle successor: standard→plan→debug→standard.                                                                      |
| `modeToStatusText(mode)`                 | `'standard' \| 'plan mode' \| 'debug mode'` (FR-5).                                                                 |
| `statusTextToMode(text)`                 | Inverse; any unknown/undefined text → `'standard'` (total).                                                         |
| `modeEntryWrite(mode)`                   | `{ mode }` persistence payload (FR-4/D4).                                                                           |
| `modeEntryRead(data)`                    | Total read: `{ mode }` → mode; `{ enabled: true }` → `'plan'`; `{ enabled: false }`/missing/garbage → `'standard'`. |
| `togglePlanMode(mode)`                   | plan↔standard; debug→plan (FR-1/D2).                                                                                |
| `toggleDebugMode(mode)`                  | debug↔standard; plan→debug (FR-1/D2).                                                                               |
| `restoreMode(debugFlag, persisted)`      | persisted wins; else flag → debug; else standard (D8).                                                              |
| `DEBUG_MODE_NOTE`                        | The exact FR-7 English note (below).                                                                                |
| `debugPromptAppend(systemPrompt)`        | `${systemPrompt}\n\n${DEBUG_MODE_NOTE}` (FR-6/FR-7).                                                                |
| `applyModeTools(state, mode, planTools)` | Pure tool-set transition (D9), see §5.                                                                              |

The exact note (FR-7, must be byte-for-byte):

```
[DEBUG MODE]
The user is reporting a bug. Before changing any code, complete this workflow in order:
1. Read and search the relevant business logic under investigation.
2. Define that business logic as invariants and reproduce the bug via property-based testing.
3. Fix the bug, then add or complete unit tests as regression tests.
```

**`src/plan-mode.ts` (modified):** becomes the mode wiring module.

- Existing exports unchanged: `PLAN_MODE_TOOLS`, `JOVALTUS_MODE_STATUS_KEY`,
  `JOVALTUS_EXECUTE_WIDGET_KEY`, `JOVALTUS_EXECUTE_STATUS_KEY`,
  `ExecuteWidgetState`, `buildExecuteWidgetLines`, the four widget
  transition functions, `planExecuteWidgetInitial` — byte-for-byte untouched.
- `registerPlanMode(pi, controller)` — signature gains a shared
  `ModeController`; the closure `enabled: boolean` becomes the controller's
  `mode: CardoMode`. Keeps: `/planmode` command (now
  `togglePlanMode`), `shift+p` shortcut, `plan-mode` flag, `tool_call` gate
  (blocks plan tools iff `mode !== 'plan'`), plan note handler (iff
  `mode === 'plan'`), and the **single** `session_start` restore handler
  (reads both flags + the persisted entry → `controller`).
- New `registerDebugMode(pi, controller)` in the same module: registers the
  `debug-mode` flag (default `false`), the `/debugmode` command
  (`toggleDebugMode`), and the debug `before_agent_start` note handler (iff
  `mode === 'debug'`). No shortcut, no tools, no gate (FR-12/FR-13).
- `ModeController` (created once in the factory): owns `mode` +
  `toolsBeforePlan`; exposes `get()`, `setMode(next, ctx)` which applies
  `applyModeTools`, pushes `modeToStatusText` via `ctx.ui.setStatus`, and
  persists `modeEntryWrite` via `pi.appendEntry`. Notify wording per toggle
  (exact strings below, asserted in PBT).

Exact notify strings (constants in `mode.ts` / wiring, asserted by tests):

| Transition                     | Notify (level `info`)                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| standard → debug               | `Debug mode on: the agent follows the evidence-driven debug workflow`                                            |
| debug → standard               | `Debug mode off: the agent follows the standard workflow`                                                        |
| plan → debug                   | `Debug mode on: plan mode off — the agent follows the evidence-driven debug workflow`                            |
| debug → plan (via `/planmode`) | `Plan mode on: debug mode off — plan and execute_plan are available`                                             |
| plan ↔ standard (unchanged)    | existing `Plan mode on: plan and execute_plan are available` / `Plan mode off: plan and execute_plan are hidden` |

**`src/index.ts` (modified):** factory creates the `ModeController` and calls
`registerPlanMode(pi, controller)` + `registerDebugMode(pi, controller)`.
Everything else (pipeline tools, dispatch, execute widget streaming, state
injection) untouched.

### 3.3 Desktop (`// Cardo:` patches)

| File                                                 | Change                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                                        | Classify `jovaltus-mode` status text into `'standard' \| 'plan mode' \| 'debug mode'` (replaces `text === "plan mode"`). `handleToggleJovaltusMode` computes the next mode via the cycle and submits the mapped command (`/planmode` \| `/debugmode` \| `/debugmode`), guarded by `resolveRuntimeSlashCommand` for the _chosen_ command; `jovaltusAvailable` guard unchanged. |
| `src/jovaltus-ui.tsx`                                | `JovaltusModeButton` props become `{ mode, onToggle }`; label = current mode name; `aria-pressed = mode !== 'standard'`; title reflects the cycle; `data-testid="jovaltus-mode-button"` kept.                                                                                                                                                                                 |
| `src/composer-surface.tsx`, `src/composer-panel.tsx` | Prop rename `planModeOn: boolean` → `mode` (three-value union).                                                                                                                                                                                                                                                                                                               |
| `src/hooks/use-session-composer.tsx`                 | No change — shift+tab already calls `onToggleJovaltusMode`, which now cycles.                                                                                                                                                                                                                                                                                                 |
| `src/new-thread-view.tsx`                            | Picker becomes three options (standard/plan/debug), `data-testid="new-thread-mode-standard"` / `-plan` / `-debug`, default standard.                                                                                                                                                                                                                                          |
| `src/hooks/use-new-thread-controller.tsx`            | `jovaltusMode: boolean` state → `mode` (default `'standard'`), reset to `standard` in `resetSurface` (FR-10 "resetting with the rest of the new-thread surface"), passed to `startThread`.                                                                                                                                                                                    |
| `src/desktop-state.ts`                               | `StartThreadInput.jovaltusMode?: boolean` → `mode?: 'plan' \| 'debug'`.                                                                                                                                                                                                                                                                                                       |
| `electron/app-store-worktree.ts`                     | `startThread` runs `/planmode` or `/debugmode` before the first message (silent, `suppressOptimisticMessage: true`) based on `input.mode` — mirrors the existing jovaltus path.                                                                                                                                                                                               |
| `electron/app-store-composer.ts`                     | **No change** — the generic runtime slash-command path already suppresses optimistic rows for any resolved command (FR-9).                                                                                                                                                                                                                                                    |
| `src/extension-session-ui.tsx`                       | **No change** — `jovaltus-mode` is already in `CUSTOM_RENDERED_STATUS_KEYS` (FR-11).                                                                                                                                                                                                                                                                                          |
| `styles/jovaltus.css`, `styles/new-thread.css`       | Reuse existing classes; the third picker option needs no new tokens (03b Warm Paper Sharp contract).                                                                                                                                                                                                                                                                          |

Runtime slash commands flow from the extension host: once `/debugmode` is
registered by the jovaltus extension, it appears in
`sessionCommandsBySession` and `resolveRuntimeSlashCommand`/`submitComposer`
handle it exactly like `/planmode` — no desktop registry changes.

### 3.4 Data flow

```
Toggle surfaces                     pi wiring (packages/jovaltus)                Effects
─────────────                        ───────────────────────────────              ───────
TUI  : /debugmode  ──┐
TUI  : /planmode    ──┤  registerCommand → controller.setMode(next, ctx)
desktop: mode button / shift+tab      │
  (submitComposer '/debugmode'|'/planmode')   ├─ applyModeTools → pi.setActiveTools
new-thread picker → startThread →           ├─ ctx.ui.setStatus('jovaltus-mode', text)
  sendMessageToSession('/debugmode',        ├─ pi.appendEntry('jovaltus-mode', {mode})
  {suppressOptimisticMessage:true})         └─ ctx.ui.notify(...)

session_start ──► controller restore: flags + last persisted entry → mode
                  └─ re-apply tools + status (single handler)

every turn ──► before_agent_start: general rules (packages/general)
              + plan note iff mode==='plan' (registerPlanMode)
              + debug note iff mode==='debug' (registerDebugMode)
desktop ──► reads 'jovaltus-mode' status → three-state button / picker
```

## 4. External dependencies

**No new dependencies.** All libraries are already in the monorepo, and the
APIs used are already exercised by existing suites (verified against repo
usage, not memory):

| Dependency                        | Version (in repo)                                      | Purpose                                                                                                                                                                                                                                                 | Verified usage                                                                                                                      |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works/pi-coding-agent` | `^0.84.1`                                              | Extension API: `registerFlag`, `registerCommand`, `appendEntry`, `on('before_agent_start')`, `on('session_start')`, `getFlag`/`getActiveTools`/`setActiveTools`, `ctx.ui.setStatus`/`notify`. All already used in `packages/jovaltus/src/plan-mode.ts`. | `dist/core/extensions/types.d.ts` (checked `ExtensionAPI`, `BeforeAgentStartEvent`, `SessionStartEvent`, `ExtensionCommandContext`) |
| `fast-check`                      | `^4.9.0` (devDep of `@cardo/jovaltus` and the desktop) | Property-based testing. New tests use only APIs already present in the repo: `fc.assert`, `fc.property`, `fc.array`, `fc.constantFrom`, `fc.boolean`, `fc.oneof`, `fc.record`, `fc.tuple`, `fc.pre`.                                                    | `packages/jovaltus/test/pbt/plan-mode.test.mts`, desktop `test/pbt/state-transitions.test.mts`                                      |
| `node:test`                       | Node ≥ 22 (built-in, pinned)                           | Test runner: `test`/`assert/strict` — matches `test:pbt` scripts.                                                                                                                                                                                       | `packages/jovaltus/package.json` scripts, existing `test/pbt/*.test.mts`                                                            |
| `@playwright/test`                | `^1.58.2` (desktop devDep)                             | Desktop contract specs (live mode UI).                                                                                                                                                                                                                  | `tests/live/jovaltus-mode-toggle.spec.ts`, `jovaltus-new-thread-mode.spec.ts`                                                       |

## 5. Business logic surface (PBT-lockable invariants)

These are the pure functions whose behavior the failing PBT spec (next phase)
must encode **before** the implementation exists. They live in
`packages/jovaltus/src/mode.ts` (compiled to `dist/mode.js`, which tests
import, per the suite convention).

1. **Cycle** — `nextMode`:
   - `nextMode³(m) === m` for every mode (cycle of length 3).
   - The cycle visits exactly the three distinct values.
2. **Status bijection** — `modeToStatusText` / `statusTextToMode`:
   - `statusTextToMode(modeToStatusText(m)) === m` for all `m ∈ CardoMode`.
   - `modeToStatusText` is injective over `CardoMode` (three distinct texts).
   - `statusTextToMode` is total: any string (incl. `undefined`, garbage) maps
     to a valid `CardoMode` without throwing.
3. **Persistence round-trip** — `modeEntryWrite` / `modeEntryRead`:
   - `modeEntryRead(modeEntryWrite(m)) === m` for all modes.
   - Legacy: `{ enabled: true }` → `'plan'`; `{ enabled: false }`, `{}`,
     `null`, `undefined`, `"garbage"`, `{ mode: "bogus" }` → `'standard'`
     (total, never throws).
4. **Toggle semantics** — `togglePlanMode` / `toggleDebugMode`:
   - `togglePlanMode('plan') === 'standard'`, `togglePlanMode('standard') === 'plan'`,
     `togglePlanMode('debug') === 'plan'` (D2).
   - `toggleDebugMode('debug') === 'standard'`, `toggleDebugMode('standard') === 'debug'`,
     `toggleDebugMode('plan') === 'debug'`.
   - Idempotent double-toggle on the own mode: `togglePlanMode²('standard') === 'standard'`,
     `toggleDebugMode²('standard') === 'standard'`.
   - Output is always a valid `CardoMode` (exclusivity: never "both").
5. **Restore precedence** — `restoreMode(debugFlag, persisted)`:
   - Persisted mode wins over the flag: `restoreMode(true, 'standard') === 'standard'`,
     `restoreMode(false, 'debug') === 'debug'`.
   - No persisted mode → flag decides: `restoreMode(true, undefined) === 'debug'`,
     `restoreMode(false, undefined) === 'standard'`.
6. **Tool-set transitions** — `applyModeTools(state, mode, planTools)` where
   `state = { active, baseBeforePlan }` and `planTools = ['plan','execute_plan']`:
   - Plan tools present in `active` **iff** `mode === 'plan'` (given the base
     never contains plan tools).
   - `active ⊆ base ∪ planTools` always (the set never grows beyond the
     captured base + plan tools).
   - Entering `plan` captures `baseBeforePlan` once; leaving `plan` restores
     `active = base \ planTools`; re-entering `plan` restores the same base
     (repeatability: a plan→standard→plan→debug sequence yields
     `active = base \ planTools` at the end).
   - `debug` never adds tools: `active` after entering debug equals
     `base \ planTools`.
7. **System-prompt append** — `debugPromptAppend(base)` + `DEBUG_MODE_NOTE`:
   - Result starts with `base` (FR-6 prefix preservation).
   - The note appears exactly once; the three numbered steps appear in order
     (regex over the note); no emoji; all-ASCII English; no reference to any
     skill file path or external document (FR-7).
   - Deterministic: applying to the same base twice yields identical strings
     (no cross-turn duplication, FR-7c).
   - The note is self-contained (starts with `[DEBUG MODE]`).

**Extension-level surface** (wiring invariants, also PBT-locked via the
existing stub harness in `test/helpers/stub-api.mts` — `captureApi` +
`makeCtx` + `jovaltusFactory`):

- `/debugmode` command registered; `/planmode` still registered; `debug-mode`
  flag registered with `default: false` (FR-3).
- Toggle sequence: after every generated sequence of ops
  (`/planmode`, `/debugmode`, `session_start` with random persisted entries +
  random flag values), the following hold simultaneously:
  - **Exclusivity:** status text ∈ `{'standard','plan mode','debug mode'}` and
    equals `modeToStatusText(controller mode)`; at most one non-standard mode.
  - **Tools:** `activeTools ∩ PLAN_MODE_TOOLS ≠ ∅` iff mode is plan.
  - **Persistence:** the last `appendEntry` data equals `modeEntryWrite(mode)`
    (last write wins); replaying `session_start` with only that entry restores
    the same mode (FR-4).
  - **Flag/entry precedence:** with a persisted entry present, `session_start`
    honors the entry over both flags; with no entry, `--debug-mode`/`--plan-mode`
    flags decide (D8).
  - **Prompt gating:** invoking every `before_agent_start` handler after the
    sequence: the debug note is present iff mode is debug, the plan note iff
    mode is plan, never both, each at most once, and the base prompt is the
    prefix of every appended result (FR-6/FR-7).
  - **Notify:** toggling into/out of debug fires an `info` notify whose text
    matches the exact strings in §3.2, including the both-change wording when
    the other non-standard mode was active (FR-2).
  - **Silent persistence consistency:** each toggle appends exactly one
    `jovaltus-mode` entry (no duplicate writes).

## 6. PBT plan

Framework and location follow `packages/jovaltus` `test:pbt` conventions
(`node --test` on `test/pbt/**/*.test.mts`, fast-check `fc.assert` +
`fc.property`, tests importing compiled `dist/` output). Two new files plus
targeted updates to one existing file; no new dependencies.

### 6.1 `packages/jovaltus/test/pbt/mode.test.mts` (new — pure invariants)

All generated with fast-check over `CardoMode` (
`fc.constantFrom('standard','plan','debug')`), strings, booleans, and
`ToolSetState`-shaped records:

| Test                      | Generator                                                                                          | Invariants locked                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| cycle                     | any mode                                                                                           | `nextMode³(m) === m`; 3 distinct values in `[m, next, next²]`    |
| status text bijection     | any mode + arbitrary strings                                                                       | round-trip; injectivity; totality of `statusTextToMode`          |
| entry round-trip + legacy | any mode + arbitrary `data` values (`fc.oneof(record, boolean, string, constant(null/undefined))`) | `read(write(m)) === m`; legacy mapping; total, never throws      |
| toggle transitions        | any mode                                                                                           | D2 mapping table; own-mode double-toggle; output always valid    |
| restore precedence        | random `(flag, persisted                                                                           | undefined)`                                                      | §5.5 table |
| tool-set transitions      | random sequences of mode changes over a generated `ToolSetState`                                   | §5.6 invariants (plan-tools iff plan; no growth; base restore)   |
| prompt append             | arbitrary base strings                                                                             | prefix; exactly-once note; steps in order; no emoji; determinism |

### 6.2 `packages/jovaltus/test/pbt/debug-mode.test.mts` (new — extension sequences)

Mirrors `plan-mode.test.mts`'s harness (`setupStub`/`captureApi`/`makeCtx`):
run `jovaltusFactory(stub.api)`, then generate **random operation sequences**
with fast-check (`fc.array` of `fc.oneof(planmode-toggle, debugmode-toggle,
session_start-with-random-entries-and-flags)`), invoking the captured
command handlers / `session_start` handler with synthetic contexts and
asserting the §5 extension-level invariants after **every** op:

- exclusivity (status + entry + tools together);
- last-write-wins persistence and restore reproduction;
- flag-vs-entry precedence;
- `before_agent_start` gating for both notes (never both, base prefix, exact
  note text once);
- notify text for every transition, including plan↔debug cross-toggles;
- deterministic, non-deterministic-exempt (no timestamps/randomness in mode
  logic).

Also a small deterministic set mirroring `plan-mode.test.mts`'s style:
`/debugmode` registered; `debug-mode` flag default false; no `tool_call`
gate behavior change for debug (plan gate untouched, FR-12); no new shortcut
registered (FR-13); `session_start` with a `{ mode: 'debug' }` entry restores
debug and sets status `'debug mode'`.

### 6.3 `packages/jovaltus/test/pbt/plan-mode.test.mts` (updated)

- Entry-shape assertions change `data: { enabled: true }` →
  `data: { mode: 'plan' }` (D4).
- `session_start` legacy-entry case (`{ enabled: true }`) stays — it now
  exercises the legacy fallback; add a `{ mode: 'debug' }` restore case.
- Keep all existing behavioral assertions (tools, gate, status, plan-note
  gating) — they hold unchanged.

### 6.4 Desktop contract coverage (Playwright, `tests/live/`)

- **`jovaltus-mode-toggle.spec.ts` (updated):** three-state cycle — button
  starts `standard` (`aria-pressed=false`), click → `plan` (`aria-pressed=true`,
  label `plan`), click → `debug` (`aria-pressed=true`, label `debug`), click →
  `standard`; shift+tab cycles identically; `/debugmode` and `/planmode` both
  stay silent (no timeline row, no generic dock bar — FR-9/FR-11).
- **`jovaltus-new-thread-mode.spec.ts` (updated):** picker shows three options
  (default standard, reset on surface reset); choosing `debug` and starting the
  thread runs `/debugmode` before the first message — the created thread's
  mode button reads `debug` immediately and no `/debugmode` timeline row
  appears (FR-10).
- Run per AGENTS.md from the desktop dir:
  `PI_APP_TEST_MODE=background PI_OFFLINE=1 PI_APP_DISABLE_CARDO_UPDATE_CHECK=1
node_modules/.bin/playwright test -c playwright.config.ts tests/live/<file>`.

### 6.5 Expected phase sequencing (test-first)

1. Write `test/pbt/mode.test.mts` + `test/pbt/debug-mode.test.mts` against
   the §5 surface → **red** (`dist/mode.js` doesn't exist / functions missing).
2. Implement `src/mode.ts`, refactor `src/plan-mode.ts`, wire
   `registerDebugMode`, update `src/index.ts` → `pnpm --filter @cardo/jovaltus test:pbt` green; update `plan-mode.test.mts`.
3. Desktop patches (`// Cardo:`) → `pnpm --filter @pi-gui/desktop build` +
   `typecheck` + `test:pbt` (unchanged, still green) + updated Playwright
   specs green.
4. Root `pnpm run lint` + `pnpm run typecheck` (max-warnings 0).

## 7. Open questions

1. **Package placement (resolved by D1, but worth user confirmation):** debug
   mode ships inside `packages/jovaltus` rather than a standalone
   `packages/debug`, because FR-1 exclusivity requires shared in-process mode
   state and the standalone path needs a new shared mode-core package plus
   desktop reconciliation of two extensions. If the user prefers
   "plugins stay as separate packages" over minimal machinery, the fallback is
   `packages/debug` + a shared pure core (e.g. `packages/mode`) imported by
   both extensions — strictly more code and a second status key / dock
   exclusion, with no user-visible benefit.
2. **Branding:** debug mode is surfaced under the `jovaltus-mode` status key
   and `jovaltus-mode-button` testid (D3/D5), so the desktop labels/branding
   keep the "Jovaltus" name even though debug is not pipeline-related. A
   neutral rename (e.g. `cardo-mode`) would ripple through persistence
   migration, dock exclusions, and specs — out of scope this iteration.
3. **Flag precedence (Open Q6 default adopted):** `--debug-mode` is honored
   only when no persisted mode entry exists (entry wins), mirroring plan mode.
   Confirm this is desired rather than flag-forces-mode.
4. **TUI shortcut (A4 default adopted):** `/debugmode` only, no shortcut
   (shift+P is plan mode's; shift+tab is `app.thinking.cycle`). Confirm.
5. **Cycle button vs direct toggle:** the composer button cycles
   standard→plan→debug→standard (FR-8's fixed cycle), which means from `plan`
   it advances to `debug`, not back to `standard`; the new-thread picker
   offers direct selection of all three. Confirm the cycle direction/order is
   acceptable.
6. **Persistence format (A7 interpretation):** the write format changes from
   `{ enabled }` to `{ mode }` with a legacy read fallback, so existing
   sessions restore identically. If A7 was intended to forbid _any_ write-side
   format change, the alternative is writing both `{ enabled, debug }`
   booleans (same read behavior, two-field payload) — marginally more code.
