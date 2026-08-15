# Module: extension (`index.ts`)

**Purpose:** pi extension entry — registers the 6 pipeline tools, the plan-mode layer (via `plan-mode.ts`), and the lifecycle events that drive the Jovaltus pipeline.

Source: `packages/jovaltus/src/index.ts` (927 LOC). The pipeline tools grew out of the Hermes plugin's `src/jovaltus/tools.py`; the plan-mode pipeline is new (see `docs/architecture.md` → Jovaltus plan mode).

## Public API

| Export    | Signature                    | Description                                                                                       |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `default` | `(pi: ExtensionAPI) => void` | Factory called by pi's loader at startup. Single default export in the package (loader contract). |

## Registered Tools

| Tool             | Parameters (typebox)                       | Behavior                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`           | `{ user_requirements: string }` (required) | **Plan-mode only.** Runs prd → design inside the tool call (user clarification first when the host has a UI), parks in `plan_waiting` for the main agent to write failing PBTs + `execution-plan.json`; `agent_settled` validates → done. Artifacts in `<cwd>/.plan/<date>/<slug>/`.                                    |
| `execute_plan`   | `{ plan_id: string }` (required)           | **Plan-mode only.** Resolves the plan session (must be `tool=plan`, `status=done`, valid `execution-plan.json`), dispatches the plan's subagents (batches serial, agents within a batch parallel); leaves changes uncommitted; result includes `{execution_mode, steps, mermaid}`. Does not chain into simplify/review. |
| `simplify`       | `{ plan?: string }` (optional)             | Runs simplify-review child; verdict loop (fix → main agent fixes → re-review).                                                                                                                                                                                                                                          |
| `review`         | `{ plan?: string }` (optional)             | Runs adversarial-review child; same verdict loop.                                                                                                                                                                                                                                                                       |
| `list_sessions`  | `{ status?: string }` (optional)           | Lists every persisted session (id, tool, status, phase, run_dir, ...), newest first; optional status filter.                                                                                                                                                                                                            |
| `resume_session` | `{ session_id: string }` (required)        | Re-activates an `interrupted`/`failed` session (id or run_dir); re-dispatches from the resume target phase. A failed `plan_waiting` session re-runs the JSON validation; a failed execute session re-runs the plan dispatch.                                                                                            |

### Tool result contract

- Success: `{ content: [{ type: "text", text }], details: { run_dir, ... } }`
- Error: `details: { isError: true }` (tool returns a value — never throws)
- Fix verdict: `details: { verdict: "fix", findings }`; text instructs the main agent to fix.
- `list_sessions`: `details: { sessions: [...] }` (one summary object per session).

## Registered Events

| Event                | Equivalent (Hermes) | Behavior                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_agent_start` | `pre_llm_call`      | Injects `[Jovaltus pipeline] id=... tool=... phase=... status=...` into every main-agent turn's system prompt when a pipeline exists (includes the plan_waiting handoff note). Plus, in plan mode, the `[JOVALTUS PLAN MODE]` system note (from `plan-mode.ts`).                            |
| `agent_settled`      | `post_llm_call`     | After the main agent's turn: for a parked `plan_waiting` pipeline, validates `execution-plan.json` → done / failed-with-reason; for a parked `*_waiting` reviewer pipeline, re-dispatches the reviewer (fix → `pi.sendUserMessage(findings)` wakes the next round; pass → notify + finish). |
| `session_start`      | — (new)             | Restores plan mode (flag + last persisted `jovaltus-mode` entry), re-applies the tool set and status (from `plan-mode.ts`).                                                                                                                                                                 |
| `tool_call`          | — (new)             | Plan-mode hard gate: while mode is off, a direct `plan`/`execute_plan` call is blocked with an actionable reason (from `plan-mode.ts`).                                                                                                                                                     |
| `session_shutdown`   | — (new)             | A still-`running` pipeline becomes `interrupted` (stopped without an error), so it can be listed and resumed later.                                                                                                                                                                         |

## Plan-mode layer (`plan-mode.ts`)

`registerPlanMode(pi)` adds the toggle surface + gating (see `docs/modules/plan-mode.md`): the `/planmode` command, `shift+p` shortcut, `--plan-mode` flag, `setActiveTools` gating, the `tool_call` gate, the plan-mode system note, `session_start` restore, and the `jovaltus-execute` widget protocol streamed during `execute_plan`.

## Dependencies

- Inbound: none (loaded by pi host).
- Outbound: `state.ts` (SQLite session machine), `chain.ts` (CHAIN/verdict), `dispatch.ts` (child runner), `prompts.ts` (render), `plan-json.ts` (execution-plan artifact IO), `plan-mode.ts` (gating + widget protocol), `@earendil-works/pi-coding-agent` (types + ExtensionAPI), `typebox` (schemas), `node:fs`, `node:path`.

## Patterns & Gotchas

- **Run-dir collision handling:** `computeRunDir` appends `-2`, `-3`, … when `<date>/<slug>` already exists (`index.ts:65-99`).
- **Review target resolution:** with a plan, run dir = plan's parent; without one, a fresh `.plan/<date>/<tool>` dir is created (`resolveReviewTarget`, `index.ts:100-115`).
- **Model inheritance:** child gets `--model <provider>/<id>:<thinking>` from the parent ctx when available (`modelPattern`, `index.ts:160`).
- **Event no-op rule:** `agent_settled` acts only when pipeline status is `running` AND phase is `*_waiting`; everything else is a no-op so the hook is effectively absent before/after a run.
- **execute_plan validation:** plan session must be `tool=plan` + `status=done` + valid `execution-plan.json` — all checked BEFORE any pipeline starts (no partial work on a bad id).
- **Interruption ≠ failure:** an aborted phase dispatch (`ctx.signal.aborted`) and an ended session both mark the pipeline `interrupted` (error stays `null`) instead of `failed`; `resume_session` is the recovery path.
- **Resume target:** a `*_waiting` session resumes by falling back to the phase's settlement logic; any other session resumes at its stored phase, with a resume note appended to the child prompt (artifact-aware continuation).

## How to Update

- New tool → register in the factory + add row to the tools table.
- Changed verdict flow → update the tool result contract + event table.
