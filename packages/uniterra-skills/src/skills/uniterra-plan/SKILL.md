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

### 3. Review the documents with the fixed workflow

- Run the fixed workflow in `scripts/review-workflow.md` with
  `args = { prd_dir, design_dir, acceptance_dir }` (in practice all three are the
  run directory).
- It dispatches three parallel review agents, each fed all three dirs:
  - **requirement-list-review** (`prompts/requirement-list-review.md`) — technical
    feasibility + contradictions between requirements.
  - **design-review** (`prompts/design-review.md`) — over-engineering, minimal
    complexity, minimal invasiveness, necessary vs unnecessary external libraries.
  - **acceptance-review** (`prompts/acceptance-review.md`) — clarity + an objective,
    verifiable piece of evidence per criterion.
- If any agent returns `pass: false` (or `null`), apply its `issues` to the docs and
  re-run until all three pass.

## Files

- `scripts/review-workflow.md` — the fixed review workflow script (embeds the three
  fixed prompts; `args` carries the three directory paths).
- `prompts/requirement-list-review.md` — requirement feasibility + contradiction agent.
- `prompts/design-review.md` — design over-engineering / minimal-invasiveness agent.
- `prompts/acceptance-review.md` — acceptance clarity + verifiable-evidence agent.
