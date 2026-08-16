# Debug Mode — Product Requirements Document

## 1. Overview

Cardo's desktop workspace already exposes a Jovaltus **plan mode**: a per-session
toggle (`/planmode` command, shift+P in the TUI, shift+tab / mode button in the
desktop composer, standard/plan picker on the new-thread page) that persists via
`pi.appendEntry`, reports state via `ctx.ui.setStatus`, and changes the main
agent's behavior through a `before_agent_start` system-prompt append. This
project adds a second user-selectable **debug mode**: when active, the agent must
follow a fixed, evidence-driven debugging workflow — (1) read and search the
relevant business logic, (2) define it as invariants and reproduce the bug via
property-based testing, (3) fix the bug and add/complete unit tests as
regression tests — delivered as an English system-prompt append that follows the
same established toggle/persistence/status patterns as plan mode.

## 2. Goals

- **G-1.** Users can select debug mode per session from every existing mode
  surface (TUI command, desktop composer toggle, new-thread page picker) and
  have the agent follow the 3-step debug workflow.
- **G-2.** While debug mode is ON, the English 3-step workflow note is appended
  to the agent's system prompt on every turn; while OFF, it is never present.
- **G-3.** Debug-mode state persists across session restarts/resumes exactly like
  plan mode (last state wins), and the desktop reflects the active mode in real
  time.
- **G-4.** Existing plan-mode behavior keeps working, with documented
  coordination between the two modes (one active mode per session).
- **G-5.** The debug-mode business logic (mode registry, toggle, persistence,
  status, system-prompt append) is covered by property-based test invariants in
  the same style as the existing plan-mode PBT suite, and the desktop mode UI is
  covered by the desktop PBT / Playwright contract suites.

## 3. Non-Goals

- **No new tools and no tool gating.** Debug mode adds zero tools to the agent's
  toolset and introduces no `tool_call` gate; the existing plan-mode tool gate is
  the only gate and is untouched.
- **No subagent dispatch.** Debug mode does not spawn a Jovaltus-style pipeline,
  subagents, or child processes. It only changes the main agent's instructions.
- **No debugger integration.** No process attachment, language-specific
  debuggers, DevTools protocol, or breakpoints in this iteration.
- **No changes to the `agentic-debugging` skill.** The skill stays as-is; the
  debug-mode prompt append is only _aligned_ with its methodology.
- **No changes to `packages/general`'s always-on working rules.** The debug note
  is an additional, per-session append that coexists with the general rules.
- **No redesign of plan mode.** Plan mode's existing UI, persistence, and PBT
  suite behavior is preserved (except for the coordinated exclusivity defined
  below).

## 4. Functional Requirements

### Mode model

- **FR-1 — Mode registry.** There is a single per-session mode state with
  exactly three values: `standard`, `plan`, `debug`. At most one non-standard
  mode is active at a time: enabling `debug` while `plan` is active deactivates
  `plan`, and vice versa. `standard` means neither is active. The default mode is
  `standard`.
- **FR-2 — Toggle command.** A `/debugmode` runtime slash command toggles debug
  mode ON/OFF (mirroring `/planmode`). Each invocation flips the state, updates
  the active-tools set only if a mode change requires it, updates the status, and
  persists the new mode. The user is notified via `ctx.ui.notify` with an info
  message stating the new state (e.g. "Debug mode on: the agent follows the
  evidence-driven debug workflow" / "Debug mode off"). When toggling from `plan`
  to `debug`, plan mode is deactivated in the same invocation and the notify
  message reflects both changes.
- **FR-3 — Startup flag parity.** The debug-mode module registers a boolean
  start flag (`debug-mode`, default `false`) mirroring plan mode's `plan-mode`
  flag. Starting the agent with the flag set begins the session in debug mode.
- **FR-4 — Persistence.** Every mode change persists via `pi.appendEntry` with a
  dedicated custom entry type (e.g. `jovaltus-mode` extended to carry the mode
  value, or a parallel `debug-mode` entry type — see Open Question 4). On
  `session_start`, the last persisted entry wins and the mode, tool set, and
  status are restored. If a persisted plan-mode entry exists and the new debug
  entry is the most recent, debug wins and plan is deactivated (FR-1 holds after
  restore).
- **FR-5 — Status.** The active mode is reported via `ctx.ui.setStatus` under a
  status key the desktop already consumes (or a new key registered with the
  desktop — see Open Question 4), updated on every toggle, on flag-driven start,
  and on `session_start` restore. The status text unambiguously distinguishes
  `standard`, `plan`, and `debug` (e.g. `'standard' | 'plan mode' | 'debug
mode'`).

### System-prompt append

- **FR-6 — Append gating.** A `before_agent_start` handler appends the debug
  workflow note to `event.systemPrompt` **iff** debug mode is currently active.
  While debug mode is OFF the handler returns nothing and the system prompt is
  byte-for-byte unchanged from the previous handlers' output. The base prompt is
  always preserved as the prefix of the appended result.
- **FR-7 — Append content (English, exact).** The appended note is written in
  English, contains no emoji, and reads:

  ```
  [DEBUG MODE]
  The user is reporting a bug. Before changing any code, complete this workflow in order:
  1. Read and search the relevant business logic under investigation.
  2. Define that business logic as invariants and reproduce the bug via property-based testing.
  3. Fix the bug, then add or complete unit tests as regression tests.
  ```

  The note must (a) appear exactly once per system prompt, (b) contain the three
  steps in the given order, (c) not be duplicated across consecutive turns, and
  (d) be self-contained — it must not reference the `agentic-debugging` skill
  file path or any external document.

### Desktop (all changes marked `// Cardo:`)

- **FR-8 — Composer mode toggle.** The desktop composer's mode control reflects
  the active mode (`standard` / `plan` / `debug`) instead of the current binary
  plan on/off state. Activating the control selects the next mode in a fixed
  cycle (e.g. standard → plan → debug → standard); the control's label and
  `aria-pressed`/pressed state match the active mode. Shift+tab in the composer
  triggers the same cycle as the button. Both are wired **only while the owning
  extension is loaded** (its live status exists, matching the current
  `jovaltusAvailable` guard) so shift+tab stays native otherwise.
- **FR-9 — Silent toggle.** The composer mode toggle runs the mode command
  through the runtime slash-command path with the optimistic timeline row
  suppressed — toggling mode must never paint a "/debugmode" message in the
  timeline (mirrors the `/planmode` behavior locked by
  `jovaltus-mode-toggle.spec.ts`).
- **FR-10 — New-thread picker.** The new-thread page's mode picker gains a third
  option (`standard | plan | debug`), defaulting to `standard` and resetting to
  `standard` with the rest of the new-thread surface. Choosing `debug` and
  starting the thread runs the debug-mode enable command before the first message
  (silently, no timeline row, mirroring `app-store-worktree.ts`'s
  `jovaltusMode` path). The created thread's composer mode control reads `debug`
  immediately.
- **FR-11 — Dock exclusion.** The debug-mode status (and any debug UI widget
  added later) is excluded from the generic extension dock, matching the existing
  `CUSTOM_RENDERED_STATUS_KEYS` / `CUSTOM_RENDERED_WIDGET_KEYS` treatment of
  `jovaltus-mode` / `jovaltus-execute`.

### Tool set and interaction with plan mode

- **FR-12 — No tool changes.** Debug mode adds no tools, removes no tools, and
  does not alter the `tool_call` gate: `plan` / `execute_plan` remain
  plan-mode-only and gated exactly as today. Enabling debug mode while plan mode
  is on removes the plan-mode tools from the active set (FR-1); re-enabling plan
  mode restores them (preserving the existing `toolsBeforePlanMode` restore
  behavior).
- **FR-13 — TUI surface.** The TUI exposes debug mode via the `/debugmode`
  command. A dedicated TUI shortcut is **not** required in this iteration
  (shift+P is already claimed by plan mode); see Open Question 5.

### Testability

- **FR-14 — PBT invariants.** The debug-mode business logic — mode registry
  (at-most-one non-standard mode), toggle transitions, persistence (last write
  wins, restore on `session_start`, flag-driven start), status updates, and
  system-prompt append gating/content — is encoded as property-based invariants
  in the plan-mode PBT style (`packages/jovaltus` `test:pbt` pattern: pure
  module functions + a fake pi backend), covering generated sequences of toggle
  / restore / flag operations.
- **FR-15 — Desktop contract coverage.** The desktop mode UI is covered by the
  existing contract suites: new Playwright specs mirroring
  `jovaltus-mode-toggle.spec.ts` and `jovaltus-new-thread-mode.spec.ts` (mode
  button reflects debug, silent toggle, new-thread picker starts a thread in
  debug mode), and the frontend↔backend mode contract covered by the desktop
  `test:pbt` suite where applicable.

## 5. Constraints & Assumptions

**Technical constraints**

- The debug-mode toggle, persistence, status, and system-prompt injection must
  follow the established plan-mode patterns in
  `packages/jovaltus/src/plan-mode.ts` (`pi.registerFlag`,
  `pi.registerCommand`, `pi.appendEntry` with a custom entry type,
  `ctx.ui.setStatus`, `before_agent_start` append, `session_start` restore) and
  the general extension's `before_agent_start` append pattern.
- Desktop changes live in `vendor/pi-gui/apps/desktop` and must be marked
  `// Cardo:`; no vendored code outside the minimal cardo patches may be edited.
- Project rules: no emoji, minimal code, no over-engineering, ESLint
  `max-warnings 0`, tests for business logic, `.js` extensions on internal
  imports, no new default exports except pi extension entry factories, no new
  dependencies without asking first.
- After changing `packages/*` source, `pnpm run build` must run (the desktop
  resolves extensions via `dist`); after changing extension business logic the
  owning package's `test:pbt` suite must pass.
- The appended system prompt must be in English (user requirement).

**Assumptions (documented defaults — see Open Questions)**

- **A1. Placement:** Debug mode ships as a new standalone extension package
  `packages/debug` (entry is a default-exported factory), registered in
  `packages/runtime` `builtinExtensionFactories` + `builtinExtensionMetadata`,
  keeping `packages/jovaltus` focused on the pipeline and giving debug mode its
  own PBT suite without disturbing plan mode's. The mode registry/toggle
  machinery may be extracted from `plan-mode.ts` into shared code only if that is
  the minimal-change path the design doc selects.
- **A2. Exclusivity:** `standard | plan | debug` are mutually exclusive
  single-select modes (FR-1). This extends — rather than breaks — the current
  binary plan toggle.
- **A3. Desktop surface:** the full mode UI (composer toggle + 3-option
  new-thread picker) is required, following plan-mode patterns — a command-only
  surface is insufficient because users must be able to start a thread already
  in debug mode.
- **A4. TUI surface:** `/debugmode` command only; no new TUI shortcut this
  iteration.
- **A5. Startup flag:** `debug-mode` start flag mirrors `plan-mode`.
- **A6. Status key:** the desktop derives mode state from a single source of
  truth (one status key whose value distinguishes all three modes, or one
  dedicated key per mode if the design doc prefers); the FR-5/FR-11 requirements
  are agnostic to which.
- **A7. No change to plan mode's persisted entry format:** existing sessions with
  a persisted `jovaltus-mode` entry continue to restore to plan mode (or
  standard) exactly as today; the design doc must define the migration-compatible
  persistence for the three-value mode.

## 6. Out of Scope

- Debug session history, logging, or a persisted "debug run" artifact (the only
  persisted state is the mode flag).
- Auto-detection or triage of bugs — the user describes the bug; the agent runs
  the workflow.
- Running plan mode and debug mode simultaneously (exclusive by design, FR-1).
- Language/runtime-specific debugging tooling, breakpoints, or process attach.
- Changes to the `agentic-debugging` skill or `packages/general`'s rules.
- New desktop surfaces beyond the mode toggle and the new-thread picker option
  (no separate debug panel, no dock additions).
- Documentation-site or README updates beyond code-level comments.

## 7. Open Questions

1. **Package placement** — should debug mode live in its own package
   (`packages/debug`, the default assumption A1) or inside an existing package
   (`packages/jovaltus` next to `plan-mode.ts`, or `packages/general` as a
   prompt-append extension)? Trade-off: standalone keeps blast radius minimal and
   matches "plugins stay as separate packages"; in-jovaltus reuses the mode
   machinery with the least new scaffolding; in-general conflicts with general's
   always-on, non-toggleable contract.
2. **Desktop surface depth** — is the full mode UI (composer toggle + 3-option
   new-thread picker, assumption A3) required, or is a command/shortcut-only
   surface acceptable? (Default: full picker, mirroring plan mode.)
3. **Exclusivity** — confirm modes are mutually exclusive (`standard | plan |
debug`, FR-1 / A2) rather than independent toggles that could both be active.
4. **Status key** — should the desktop consume one shared status key carrying
   all three mode values (minimal desktop diff: `text === 'plan mode'` becomes a
   three-way switch) or a separate `debug-mode` key (parallel button/shortcut,
   more desktop surface)? (See A6.)
5. **TUI shortcut** — is a `/debugmode`-only TUI surface acceptable (A4), or
   should a non-conflicting shortcut be added (shift+P is taken by plan mode)?
6. **Startup flag semantics** — confirm `--debug-mode` should force debug mode
   even when a persisted mode entry says otherwise, or whether the flag should
   only apply when no persisted state exists (mirror of plan mode's current
   flag-vs-entry precedence — plan mode currently lets the persisted entry
   override the flag).
