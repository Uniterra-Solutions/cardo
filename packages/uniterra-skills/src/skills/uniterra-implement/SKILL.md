---
name: uniterra-implement
description: >
  Company-standard implementation phase on DeepSeek Harness: PBT-first
  execution against an explicit requirements list. Simple tasks (single-module
  changes) go inline — define the business logic as invariants, write the
  FAILING property tests, then implement until green. Complex tasks
  (cross-module features) first write ALL failing property tests, then
  dispatch subagents through a dynamic workflow: batched mode (parallel
  within a batch, serial across batches) when tasks overlap, fully parallel
  when they do not. LOAD when:
  - User asks to execute an approved plan (execute_plan / 執行計畫)
  - User asks to implement a planned or well-specified task/feature
  Do NOT use for planning (uniterra-plan) or reviewing changes (uniterra-review /
  uniterra-simplify).
---

# Uniterra Implement — PBT-first execution against an explicit requirements list

Pipeline position: after `uniterra-plan`, or standalone when the task is
well-specified. Every implementation starts from an **explicit requirements
list** and the **failing property tests** that encode the business logic as
invariants — never write implementation code first.

## 0. Establish the requirements list

- **From a plan**: read `<run_dir>/execution-plan.json`. Each task entry
  carries `requirements` — the explicit, self-contained requirement list for
  that task. Read `<run_dir>/prd.md` for the project-level FR list.
- **Standalone**: derive the explicit requirements list from the user's
  request — number them REQ-1, REQ-2, …; each one unambiguous and verifiable.
  If genuinely ambiguous, confirm with `ask_user_question` BEFORE writing
  tests. When the user provided a task list, treat each task's scope as its
  own requirements group.
- Every failing test written below must trace to at least one requirement.

## 1. Classify the task

- **Simple** — single-module function changes, small well-contained edits,
  one cohesive unit of work → step 2 (inline, no subagents).
- **Complex** — cross-module new features, several interdependent or
  parallelizable tasks, schema + API + UI changes together → step 3 (dynamic
  workflow).

When unsure, prefer simple: subagents add overhead; only fan out when the
work genuinely splits.

## 2. Simple tasks — invariants → failing tests → code, inline

1. Define the business logic as invariants (same phrasing discipline as
   `uniterra-pbt-debugging`: total functions, round-trips, idempotence, no
   loss/no duplication).
2. Write the **FAILING property-based tests** first at the project's test
   location — they MUST fail against current code (red phase). These tests
   are the acceptance contract.
3. Implement the change; run the suite until every new test passes (green).
4. Follow project conventions (`AGENTS.md`): lint / typecheck / build, tests
   for new behaviour. Leave changes UNCOMMITTED — `uniterra-review` /
   `uniterra-simplify` read the diff.
5. Report what changed and which requirements each test covers.

## 3. Complex tasks — all failing tests, then a dynamic workflow

1. **Write ALL failing property tests first** in the main session: the whole
   red suite encoding every invariant from the requirements list (use the
   design doc's Business logic surface + PBT plan sections when present).
   They must all fail against current code before any implementation.
2. **Choose the execution mode by task overlap** (details in
   `references/execute-workflow.md`):
   - Tasks touch the same files/modules (overlapping work) → **batched
     mode**: parallel within a batch, serial across batches; overlapping
     tasks go in DIFFERENT batches.
   - Tasks are mutually independent (disjoint modules) → **full parallel**:
     one batch with every agent.
3. Write a `workflow` script mirroring the chosen mode (each agent's prompt
   from `references/prompts/execute-agent.md`, with the task's `task_prompt`
   AND `requirements` list substituted) and run it with the `workflow` tool.
4. After the workflow, run the FULL test suite in the main session: every
   failing PBT from step 1 must be green before handoff to review. If some
   stay red, fix inline or dispatch a follow-up agent — never declare done
   with red tests.

## Files

- `references/execute-workflow.md` — overlap analysis, mode selection, and
  the two workflow script skeletons.
- `references/prompts/execute-agent.md` — the per-task implementing subagent
  prompt (substitute `[[run_dir]]`, `[[repo_root]]`, `[[task_prompt]]`,
  `[[requirements]]`).
