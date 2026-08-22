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
   one requirement. These tests are the single acceptance target for the whole
   implementation: subagents strengthen and complete them (never rewrite them from
   scratch) and turn them green.
2. Decompose requirements + design into a **task list** (`assets/task-list-example.md`):
   one entry per task, with its `prompt` already rendered to markdown (goal, context
   files, requirements with their test, conventions, constraints). Keeping `args` flat
   (a markdown string per task) avoids the deep-nested-JSON tool-call corruption.
3. Choose the workflow shape by task overlap and write the script
   (`assets/workflow-script-example.md` for the fixed rules + return contract):
   - Independent tasks → **full parallel** (`references/parallel-workflow.md`).
   - Overlapping tasks → **batched** (`references/batched-workflow.md`).

### 3. Run the workflow script

- Run it with the `workflow` tool as **ONE call** whose `arguments` is a single object with
  `meta` + `script` + `args` together (never split across parallel calls, never wrapped in
  a field named `arguments`); each subagent reads its `task.prompt` and makes its
  requirements' failing tests green, returning a JSON report (changed files, satisfied
  requirements, deviations) via `schema`.
- **Strengthen, don't rewrite.** Each subagent works against the failing tests written in
  step 2 (its requirement's allocated test). It FIRST prioritizes strengthening / completing
  those failing test cases — extend the property, add the missing edge cases and invariant
  asserts, so the failing PBT genuinely covers the requirement — THEN makes them green.
  Never start by writing a brand-new property test from scratch for the same requirement:
  the allocated test is the acceptance target, not a starting point (see the shared
  fixed rules in `assets/workflow-script-example.md`).
- Afterwards run the FULL test suite in the main session: every failing PBT must be green
  before handoff. Red tests are the ONLY acceptable signal that work remains — fix inline
  or dispatch a follow-up agent, never declare done with red tests.

## Rules

- Do NOT commit changes; leave the working tree uncommitted so a later review reads the diff.
- Follow project conventions (`AGENTS.md`): lint / typecheck / build, tests for new behaviour.

## Files

- `assets/task-list-example.md` — the per-task contract (pre-rendered markdown `prompt`) + example.
- `assets/workflow-script-example.md` — the ONE-call submission format, fixed rules, return schema.
- `references/parallel-workflow.md` — scenario: independent tasks → full parallel.
- `references/batched-workflow.md` — scenario: overlapping tasks → batched.
