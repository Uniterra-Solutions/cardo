# Plan Workflow (cardo-plan)

Goal: turn raw requirements into an approved, test-ready execution plan via
dynamic workflow. All artifacts land in the run directory. The plan owns
PRD/design/execution-plan; writing the failing property tests is
`cardo-implement`'s job (the design doc's PBT plan tells it which invariants
to encode).

## Run directory

`<repo>/.plan/<YYYYMMDD>/<plan-name>/` — create it once at the start. Use a
slug of the requirements (first ~6 words, lowercase, dash-joined) as the
plan name; append `-2`, `-3` … on collision.

## Steps

### 1. Clarify

Before any subagent runs, resolve genuine ambiguity with the user:

- Read the requirements; identify at most 5 open questions that genuinely
  need user confirmation.
- Ask them ONE at a time with `ask_user_question`: 2–4 concrete suggested
  options each, the first being your recommended default. A free-text
  "Other" path is available — never write "other" as an option yourself.
- Write the answers to `<run_dir>/clarify.md` (a Q&A list). If there are no
  open questions, skip the dialog and note that in `clarify.md`.

### 2. PRD subagent

Dispatch a `workflow` run with one `agent()` call:

- Prompt: `references/prompts/prd.md` with `[[run_dir]]`, `[[repo_root]]`,
  and `[[user_requirements]]` substituted. The PRD agent writes
  `<run_dir>/prd.md` (Overview / Goals / Non-Goals / Functional
  Requirements / Constraints & Assumptions / Out of Scope).
- The PRD agent does NOT produce open questions — clarification already
  happened in step 1.
- `phase('prd')` before the call; `label: 'prd'`.

### 3. Design subagent

A second `agent()` call in the same workflow:

- Prompt: `references/prompts/design.md` with the same substitutions plus the
  PRD path. Writes `<run_dir>/design.md`.
- `phase('design')`; `label: 'design'`.

The workflow returns `{ status: 'done', prd: <path>, design: <path> }`.

### 4. Execution plan (main agent, after the workflow)

Write `execution-plan.json` (schema below). Requirements decomposition:

- Break the PRD's Functional Requirements into tasks along module/seam
  boundaries — one task per cohesive unit of work.
- For each task, copy the FRs it satisfies into its `requirements` list as
  self-contained sentences (an implementing agent reads only this list, not
  the PRD). Every FR must appear in at least one task; a task may satisfy
  several.
- Choose `execution_mode` by task overlap (same rule cardo-implement applies
  when executing):
  - no shared files/modules between tasks → `parallel`;
  - overlapping tasks → `batched` (tasks touching the same files go in
    DIFFERENT batches; batches run serially);
  - a strict dependency chain → `serial`.

### 5. Approval

Present the complete plan — PRD, design, execution plan — to the user for
approval before implementation. If they approve, hand off to
`cardo-implement`; if they ask for changes, revise and re-present.

## execution-plan.json schema

```json
{
  "execution_mode": "serial" | "batched" | "parallel",
  "batches": [
    [
      {
        "id": "agent-id",
        "task_prompt": "self-contained instruction",
        "requirements": ["REQ-n: self-contained requirement sentence"]
      }
    ]
  ]
}
```

- `serial`: N batches × exactly 1 agent.
- `batched`: M batches × ≥1 agent; batches run serially, agents within a
  batch run in parallel.
- `parallel`: exactly 1 batch × all agents.
- ids: `/^[A-Za-z0-9_-]+$/`, globally unique.
- task_prompt: non-empty, self-contained — the PRD + design doc are injected
  into every dispatched agent's context, so the task prompt must stand alone.
- requirements: non-empty, self-contained per task; the acceptance list
  `cardo-implement` writes failing property tests against.
