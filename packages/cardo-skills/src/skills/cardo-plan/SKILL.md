---
name: cardo-plan
description: >
  Company-standard planning phase on DeepSeek Harness (Jovaltus methodology).
  Turns raw requirements into an approved, test-ready execution plan: clarify
  open questions with the user, dispatch PRD + design subagents through a
  dynamic workflow, and emit execution-plan.json whose tasks carry an
  explicit requirements list for cardo-implement. LOAD when:
  - User asks to plan a feature or task (prd / design / plan / 規劃 / 計畫)
  - User references Jovaltus planning or asks for an execution plan
  Do NOT use for:
  - Executing a plan or implementing (cardo-implement)
  - Reviewing or simplifying changes (cardo-review / cardo-simplify)
---

# Cardo Plan — turn requirements into an approved, test-ready plan

Pipeline position: **plan → implement → simplify/review**. This skill owns the
plan phase only; the red phase (writing the FAILING property tests) belongs to
`cardo-implement`, which consumes the artifacts produced here.

Everything is artifact-driven and lives under a **run directory**:
`<repo>/.plan/<YYYYMMDD>/<plan-name>/`. The run dir holds `prd.md`,
`design.md`, and `execution-plan.json`.

## Steps

1. Read the user's requirements; before drafting, **clarify open questions**
   with the user via `ask_user_question` (options + Other), one at a time, at
   most 5. Save answers to `<run_dir>/clarify.md`.
2. Run a `workflow` script that dispatches two subagents in order:
   - **PRD agent** — read `references/prompts/prd.md` for the role prompt;
     writes `<run_dir>/prd.md` (its Functional Requirements list is the
     project-level requirements list).
   - **Design agent** — read `references/prompts/design.md`; writes
     `<run_dir>/design.md` (its Business logic surface + PBT plan sections
     tell cardo-implement which invariants the red tests must encode).
3. Write `execution-plan.json` — the batch-major execution plan. Every task
   entry carries a `requirements` list (see schema below): the explicit,
   self-contained requirement list the implementing agent must satisfy.
   Derive each task's requirements from the PRD's FR list; every FR must be
   covered by at least one task.
4. Present the complete plan — PRD, design, execution plan — to the user for
   **approval** before any implementation. If they ask for changes, revise
   and re-present.

## execution-plan.json schema

```json
{
  "execution_mode": "batched",
  "batches": [
    [
      {
        "id": "db-schema",
        "task_prompt": "Create the schema migration ...",
        "requirements": [
          "REQ-1: the migration is idempotent and re-runnable",
          "REQ-3: every table row carries created_at/updated_at"
        ]
      }
    ]
  ]
}
```

- `serial` = N batches × 1 agent (linear chain); `batched` = batches run
  serially, agents within a batch in parallel; `parallel` = one batch with
  every agent.
- `requirements`: REQUIRED, non-empty array of strings — the explicit
  requirement list this task must satisfy, copied from the PRD FRs and made
  self-contained. `cardo-implement` writes its failing property tests against
  this list.
- ids match `/^[A-Za-z0-9_-]+$/`, globally unique; task_prompt non-empty and
  self-contained (PRD + design are injected into every dispatched agent's
  context by cardo-implement).

## Files

- `references/plan-workflow.md` — full plan guidance (clarify rules, run-dir
  naming, schema details).
- `references/prompts/prd.md`, `references/prompts/design.md` — the two
  subagent role prompts (substitute `[[run_dir]]`, `[[repo_root]]`,
  `[[user_requirements]]`).
