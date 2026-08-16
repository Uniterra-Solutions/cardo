---
name: cardo-planmode
description: >
  Company-standard plan-mode development pipeline on DeepSeek Harness.
  Guides the agent through Jovaltus methodology using native dynamic
  workflows: plan (clarify → PRD/design subagents → failing PBTs +
  execution-plan.json), execute (workflow script from the plan), and
  simplify/review (fix ↔ review loop with structured verdicts).
  LOAD when:
  - User asks to plan a feature or task (prd / design / plan)
  - User asks to execute an approved plan (execute_plan / 執行計畫)
  - User asks to simplify or review uncommitted changes
  - User references Jovaltus, cardo-planmode, or the plan pipeline
  Do NOT use for:
  - Ordinary coding requests with no pipeline intent
  - One-shot review of a single file (use the review skill instead)
---

# Cardo Plan-Mode Pipeline

The company-standard way to run a development task: plan → execute →
simplify → review. Execution is delegated to DeepSeek Harness native
**dynamic workflows**: you write the orchestration script from these
guidelines, then hand it to the `workflow` tool — the harness runs the
subagents, streams progress, and returns the script's final value. No
custom code runs the pipeline.

Everything is artifact-driven and lives under a **run directory**:
`<repo>/.plan/<YYYYMMDD>/<plan-name>/`. The run dir holds `prd.md`,
`design.md`, `clarify.md`, and `execution-plan.json`. Session history is
the durable record — no separate store.

## 1. Plan

1. Read the user's requirements; before drafting, **clarify open
   questions** with the user via `ask_user_question` (options + Other),
   one at a time, at most 5. Save answers to `<run_dir>/clarify.md`.
2. Run a `workflow` script that dispatches two subagents in order:
   - **PRD agent** — read `references/prompts/prd.md` for the role prompt;
     writes `<run_dir>/prd.md`.
   - **Design agent** — read `references/prompts/design.md`; writes
     `<run_dir>/design.md`.
3. Back in the main session, write the **FAILING property-based tests**
   (red phase — they must fail against current code) at the project's
   test location.
4. Write `execution-plan.json` — the batch-major execution plan:

```json
{
  "execution_mode": "batched",
  "batches": [
    [{ "id": "db-schema", "task_prompt": "..." }],
    [{ "id": "webhook-handler", "task_prompt": "..." }]
  ]
}
```

   - `serial` = N batches × 1 agent (linear chain); `batched` = batches run
     serially, agents within a batch in parallel; `parallel` = one batch
     with every agent.
   - ids match `/^[A-Za-z0-9_-]+$/`, globally unique; task_prompt
     non-empty and self-contained (PRD + design are injected into every
     dispatched agent's context).
5. Present the complete plan to the user for approval before executing.

## 2. Execute

Read `execution-plan.json`, then write a `workflow` script that mirrors
its shape: each batch is a `parallel()` of `agent()` calls (one per
agent id), batches run sequentially. Each agent's prompt comes from
`references/prompts/execute-agent.md` with the task_prompt substituted.
The script ends with `return { status: 'done' | 'failed', ... }`.

## 3. Simplify / Review

Loop until the reviewer passes or the round cap is hit:

- **Fix agent** (round ≥ 2): prompt it to address the previous reviewer's
  findings against the uncommitted diff.
- **Review agent**: prompt from `references/prompts/review.md` (review) or
  `references/prompts/simplify-review.md` (simplify); use a `schema` on
  the `agent()` call so it returns `{ verdict: 'pass'|'fix', findings }`
  as structured output.
- On `pass`, return `{ status: 'done', rounds }`. On `fix`, feed the
  findings into the next fix round. Cap at `maxRounds` (e.g. 8) and
  return `{ status: 'blocked' }` past the cap.

## Files

- `references/prompts/` — the five phase role prompts (substitute
  `[[token]]` placeholders with the run dir, repo root, requirements).
- `references/plan-workflow.md` — full plan guidance.
- `references/execute-workflow.md` — full execute guidance.
- `references/review-workflow.md` — full simplify/review loop guidance.
