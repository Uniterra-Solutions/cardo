---
name: uniterra-plan
description: >
  Company-standard planning phase on DeepSeek Harness (Jovaltus methodology).
  Turns raw requirements into reviewed planning artifacts: clarify the
  requirements and architecture interactively with the user, write prd.md /
  design.md / acceptance.md, then dispatch three parallel review agents
  (requirement feasibility, design over-engineering, acceptance verifiability)
  to review them. LOAD when:
  - User asks to plan a feature or task (prd / design / plan / 規劃 / 計畫)
  - User references Jovaltus planning or asks for an execution plan
  Do NOT use for:
  - Executing a plan or implementing (uniterra-implement)
  - Reviewing or simplifying changes (uniterra-review / uniterra-simplify)
---

# Uniterra Plan — turn requirements into reviewed planning artifacts

Pipeline position: **plan → implement → simplify/review**. This skill owns the
plan phase only: it produces `prd.md`, `design.md`, and `acceptance.md`, then
reviews them with three parallel agents before handoff.

Artifacts live under a **run directory**: `<repo>/.plan/<YYYYMMDD>/<plan-name>/`,
holding `prd.md`, `design.md`, and `acceptance.md`.

## Steps

### 1. Understand requirements and design interactively

- Read the user's requirements.
- Clarify with the user via `ask_user_question` (options + Other), one at a time,
  to complete the requirements list AND the architecture design: what to build,
  module boundaries, data shapes, external dependencies.

### 2. Produce prd.md, design.md, acceptance.md

Write them yourself in the main session (no authoring subagents):

- `prd.md` — the Functional Requirements list (project-level requirements).
- `design.md` — the architecture design (module boundaries, data shapes, the
  business-logic surface).
- `acceptance.md` — the acceptance criteria: one entry per requirement, each naming
  an objective, verifiable piece of evidence (a test, a command output, an observable
  behavior).

### 3. Confirm the plan broadly matches the user's needs

Before the automated review, get a sanity check from the user so the plan actually
fits their needs:

- Read back the three documents with a short summary: what the plan builds, the key
  requirements, and how each is verified.
- Ask via `ask_user_question` (options + Other) whether the content is broadly correct
  and matches what they want. Keep it to a single confirming question, e.g. "Does this
  plan match your needs? / Are the requirements correct?"
- If they raise issues or select "needs changes", apply the edits to
  `prd.md` / `design.md` / `acceptance.md` yourself and show the result again. Only
  proceed to the automated review once the user confirms the content is broadly correct.

### 4. Review the documents with the fixed workflow

- Run the fixed workflow in `scripts/review-workflow.md` with the `workflow` tool as **ONE
  call** whose `arguments` is a single object with `meta` + `script` + `args` together
  (never split across parallel calls, never wrapped in a field named `arguments`).
  `args = { prd_dir, design_dir, acceptance_dir }` (in practice all three are the run
  directory). The review and repair subagents report to the workflow as JSON (validated by
  the `schema` each `agent(...)` call passes); only their input prompts are text.
- It dispatches three parallel review agents, each fed all three dirs:
  - **requirement-list-review** (`prompts/requirement-list-review.md`) — technical
    feasibility + contradictions between requirements.
  - **design-review** (`prompts/design-review.md`) — over-engineering, minimal
    complexity, minimal invasiveness, necessary vs unnecessary external libraries.
  - **acceptance-review** (`prompts/acceptance-review.md`) — clarity + an objective,
    verifiable piece of evidence per criterion.
- A failing axis's `issues` are handed to a single **repair agent** that applies them
  to the documents itself (no manual editing in the main session).
- After a repair, only the axes that FAILED the previous round are re-dispatched — an
  axis that already passed is never re-reviewed. So as fixes land, the number of review
  agents dispatched each round shrinks from 3 toward 0. The loop ends when all three
  pass (or `maxRounds`, default 8, is hit).

## Files

- `scripts/review-workflow.md` — the fixed review workflow script (embeds the three
  fixed prompts + the repair agent; `args` carries the three directory paths).
- `prompts/requirement-list-review.md` — requirement feasibility + contradiction agent.
- `prompts/design-review.md` — design over-engineering / minimal-invasiveness agent.
- `prompts/acceptance-review.md` — acceptance clarity + verifiable-evidence agent.
