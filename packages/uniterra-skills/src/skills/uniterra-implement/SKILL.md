---
name: uniterra-implement
description: >
  Company-standard implementation phase on DeepSeek Harness: PBT-first
  execution against an explicit requirements list. Establish the requirements
  and design (interactive clarification via ask_user_question when anything is
  unclear), decompose into tasks, then dispatch subagents through a workflow
  script — fully parallel when tasks are independent, batched (parallel within
  a batch, serial across batches) when they overlap — to turn the failing
  property tests green. LOAD when:
  - User asks to execute an approved plan (execute_plan / 執行計畫)
  - User asks to implement a planned or well-specified task/feature
  Do NOT use for planning (uniterra-plan) or reviewing changes (uniterra-review /
  uniterra-simplify).
---

# Uniterra Implement — PBT-first execution against an explicit requirements list

Pipeline position: after `uniterra-plan`, or standalone when the task is well-specified.
Every implementation starts from an explicit requirements list and the failing property
tests that encode the business logic as invariants — never write implementation code first.

## Workflow

### 1. Establish requirements and design

- Collect the requirements list and the design. From a plan: read the PRD and design
  doc in the run directory. Standalone: derive them from the user's request.
- **No design doc?** Build one interactively with the user via `ask_user_question` —
  architecture, data shapes, module boundaries, external dependencies.
- **Any requirement unclear?** Clarify with the user via `ask_user_question` before
  proceeding. Number requirements REQ-1, REQ-2, …; each must be unambiguous and verifiable.

### 2. Write failing tests, decompose into tasks, write the workflow script

1. Write ALL failing property-based tests first in the main session — the red suite
   encoding every invariant from the requirements list. Every test traces to at least
   one requirement.
2. Decompose requirements + design into a **task list** (`assets/task-list-example.md`):
   one entry per task, carrying its requirements (with the test that covers each),
   context files, conventions, and constraints (owned / forbidden files).
3. Choose the workflow shape by task overlap and write the script
   (`assets/workflow-script-example.md` for the shared render function + return contract):
   - Independent tasks → **full parallel** (`references/parallel-workflow.md`).
   - Overlapping tasks → **batched** (`references/batched-workflow.md`).

### 3. Run the workflow script

- Run it with the `workflow` tool; each subagent makes its requirements' failing tests
  green and returns a structured report (changed files, satisfied requirements, deviations).
- Afterwards run the FULL test suite in the main session: every failing PBT must be green
  before handoff. Red tests are the ONLY acceptable signal that work remains — fix inline
  or dispatch a follow-up agent, never declare done with red tests.

## Rules

- Do NOT commit changes; leave the working tree uncommitted so a later review reads the diff.
- Follow project conventions (`AGENTS.md`): lint / typecheck / build, tests for new behaviour.

## Files

- `assets/task-list-example.md` — the per-task JSON contract + example.
- `assets/workflow-script-example.md` — shared render function, fixed rules, return schema.
- `references/parallel-workflow.md` — scenario: independent tasks → full parallel.
- `references/batched-workflow.md` — scenario: overlapping tasks → batched.
