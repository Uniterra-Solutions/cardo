# Module: plan mode (`plan-mode.ts`)

**Purpose:** The plan-mode toggle surface, tool gating, persistence, and the execute-panel widget protocol. Makes `plan`/`execute_plan` a mode instead of always-active tools.

Source: `packages/jovaltus/src/plan-mode.ts` (221 LOC). Registered from the entry factory (`index.ts` → `registerPlanMode(pi)`).

## Mode semantics

Plan mode is a **per-session toggle**. While ON the main agent gains the plan-mode pipeline tools (`plan`, `execute_plan`) plus a `[JOVALTUS PLAN MODE]` system note; while OFF those tools are hidden (`setActiveTools`) and any direct call is blocked by a `tool_call` gate with an actionable reason (`Enable it with shift+tab (desktop), shift+P (terminal), or /planmode.`).

```text
ON:   tools = getActiveTools() ∪ {plan, execute_plan}   (+ system note)
OFF:  tools = getActiveTools() \ {plan, execute_plan}   (tool_call gate blocks)
```

The pre-plan-mode tool set is remembered once so disabling restores it exactly (mirrors pi's official plan-mode example). `simplify` / `review` / `list_sessions` / `resume_session` stay always-active.

## Toggle surface

| Surface                | Host    | Notes                                                                                                                                            |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/planmode` command    | all     | `registerCommand('planmode', ...)` — the canonical toggle                                                                                        |
| `shift+p` shortcut     | TUI     | Bare shift+P (user-mandated fallback — the TUI keeps shift+tab for `app.thinking.cycle`)                                                         |
| `shift+tab`            | desktop | Composer keydown submits `/planmode` (only wired while the extension's live status exists)                                                       |
| mode button            | desktop | `apps/desktop/src/jovaltus-ui.tsx` — aria-pressed toggle, accent dot when on                                                                     |
| new-thread mode picker | desktop | `new-thread-view.tsx` `.new-thread__mode` — standard/plan picker on the new-thread page; `startThread` runs `/planmode` before the first message |
| `--plan-mode` flag     | any     | `registerFlag('plan-mode', ...)` — start ON                                                                                                      |

## Persistence & restore

- Toggle state is persisted via `pi.appendEntry('jovaltus-mode', { enabled })` (custom entry type).
- `session_start` restores it: the flag wins if set; otherwise the last `jovaltus-mode` entry decides. Tools + status are re-applied on every start/resume.
- The desktop button reads the live status under `JOVALTUS_MODE_STATUS_KEY` (`jovaltus-mode` → `"plan mode"` | `"standard"`), which also serves as the extension-loaded signal for wiring shift+tab.

## Execute-panel widget protocol

`execute_plan` streams the panel state with `ctx.ui.setWidget("jovaltus-execute", lines)` (`JOVALTUS_EXECUTE_WIDGET_KEY`). Lines are structured (`STATUS|…`, `MODE|…`, `STEP|<n>`, `BATCH|<i>|<ids>`, `AGENT|<id>|<state>`) — values never contain `|`, so the frontend splits on the first field:

| Line     | Shape                          | Meaning                                                     |
| -------- | ------------------------------ | ----------------------------------------------------------- |
| `STATUS` | `running` \| `done`            | terminal `done` → green light, frontend auto-fades after 3s |
| `MODE`   | serial / batched / parallel    | execution mode from the parsed plan                         |
| `STEP`   | 0-based batch index, `-1` done | current batch (drives the active-batch highlight)           |
| `BATCH`  | `i`,`comma-joined ids`         | one line per batch (the graph groups)                       |
| `AGENT`  | `id`, `pending                 | running                                                     | done` | per-node light in the graph popup |

Pure transition helpers (`planExecuteWidgetInitial/AgentStart/AgentDone/Done`, `buildExecuteWidgetLines`) make the protocol property-testable — locked by `plan-mode.test.mts` including a fast-check property that no value contains `|`.

The desktop renders the panel + right-side graph popup natively from these lines (`jovaltus-ui.tsx` + `styles/jovaltus.css`, both `// Cardo:` marked); it never parses mermaid or free text. The widget is excluded from the generic extension dock (`CUSTOM_RENDERED_WIDGET_KEYS` in `extension-session-ui.tsx`) to avoid double rendering.

## Dependencies

- Inbound: `index.ts` (registration + widget streaming), `plan.ts` (ExecutionPlan for widget initial state).
- Outbound: `@earendil-works/pi-coding-agent` (ExtensionAPI/ExtensionContext).

## Patterns & Gotchas

- **Gate, don't trust:** the model can still attempt a plan-mode tool while off — the `tool_call` gate returns `{ block: true, reason }` instead of letting it fail confusingly.
- **No UI, no crash:** widget pushes are no-ops in headless hosts (`ctx.ui` may be absent); the pipeline still streams results in the tool result.
- **shift+P is a bare-key tradeoff:** it can intercept uppercase P typing in the TUI input — the user-mandated fallback because the TUI owns shift+tab (`app.thinking.cycle`).

## How to Update

- New mode-gated tool → add to `PLAN_MODE_TOOLS` + the tests; a new toggle surface → `registerCommand`/`registerShortcut` + desktop wiring.
- Widget protocol change → update `buildExecuteWidgetLines` + `parseJovaltusExecuteWidget` (desktop) + the PBT suite in lockstep.
