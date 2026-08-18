---
name: uniterra-simplify
description: >
  Company-standard simplification review on DeepSeek Harness. Usable whenever
  there is a review scope — no plan required: establish the scope (uncommitted
  changes by default, or the files/refs the user names), then run a dynamic
  workflow fix ↔ simplify-review loop until the reviewer passes or the round
  cap is hit. LOAD when:
  - User asks to simplify code, cut over-engineering, or reduce complexity
    (simplify / 簡化 / 精簡 / 重構減量)
  - User asks to run the simplify phase after implementation
  Do NOT use for adversarial correctness review (uniterra-review), planning
  (uniterra-plan), or implementing (uniterra-implement).
---

# Uniterra Simplify — scope-bound simplification loop

Pipeline position: after `uniterra-implement`, or standalone. Only two things
are needed to run it: a **review scope** and the uncommitted working tree.
Both the fix and review agents run inside ONE dynamic workflow script.

## 1. Establish the review scope (required)

Before dispatching anything, pin down exactly WHAT gets reviewed:

- **Default**: the uncommitted changes — `git status`, `git diff`.
- The user may name files, directories, or a ref (e.g. `src/foo.ts`,
  `packages/bar/`, `git diff HEAD~2`). Convert that into the concrete
  command(s) the reviewer will run.
- Substitute the scope into the review prompt's `[[review_scope]]` token; the
  reviewer inspects ONLY the scope and reports findings against it.

Write the verdict artifact into a review dir: `<run_dir>` when running as
the pipeline phase after a plan, otherwise `<repo>/.review/<YYYYMMDD>/<slug>/`.

## 2. Run the dynamic workflow

Write a `workflow` script implementing the loop (see
`references/simplify-workflow.md` for the skeleton and rules):

- **Fix agent** (round ≥ 2): address the previous reviewer's findings against
  the working tree, staying inside the review scope.
- **Simplify-review agent**: prompt from
  `references/prompts/simplify-review.md`; call `agent()` with a `schema` so
  it returns `{ verdict: 'pass'|'fix', findings }` as structured output.
- On `pass`, return `{ status: 'done', rounds }`. On `fix`, feed the findings
  into the next round. Cap at `maxRounds` (e.g. 8); past the cap return
  `{ status: 'blocked' }`.

## Rules

- Review agents are READ-ONLY: they never modify code.
- Fix agents leave changes UNCOMMITTED (the next round reads the diff).
- Simplification must preserve behaviour — the reviewer flags any suggested
  change that would alter semantics.

## Files

- `references/simplify-workflow.md` — the loop skeleton and scope rules.
- `references/prompts/simplify-review.md` — the reviewer role prompt
  (substitute `[[run_dir]]`, `[[repo_root]]`, `[[review_scope]]`).
