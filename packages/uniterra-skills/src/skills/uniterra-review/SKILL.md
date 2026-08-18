---
name: uniterra-review
description: >
  Company-standard adversarial review on DeepSeek Harness. Usable whenever
  there is a review scope — no plan required: establish the scope (uncommitted
  changes by default, or the files/refs the user names), then run a dynamic
  workflow fix ↔ adversarial-review loop until the reviewer passes or the
  round cap is hit. LOAD when:
  - User asks to review changes, hunt for bugs, or run the review phase
    (review / 審查 / code review)
  - User asks to verify uncommitted work against its requirements
  Do NOT use for simplification review (uniterra-simplify), planning
  (uniterra-plan), or implementing (uniterra-implement).
---

# Uniterra Review — scope-bound adversarial review loop

Pipeline position: after `uniterra-implement`, or standalone. Only two things
are needed to run it: a **review scope** and the uncommitted working tree.
Both the fix and review agents run inside ONE dynamic workflow script.

## 1. Establish the review scope (required)

Before dispatching anything, pin down exactly WHAT gets reviewed:

- **Default**: the uncommitted changes — `git status`, `git diff`.
- The user may name files, directories, or a ref (e.g. `src/foo.ts`,
  `packages/bar/`, `git diff HEAD~2`). Convert that into the concrete
  command(s) the reviewer will run.
- When a plan exists, also point the reviewer at the requirements
  (`<run_dir>/prd.md` + `execution-plan.json`) so findings can cite contract
  violations.
- Substitute the scope into the review prompt's `[[review_scope]]` token; the
  reviewer inspects ONLY the scope and reports findings against it.

Write the verdict artifact into a review dir: `<run_dir>` when running as
the pipeline phase after a plan, otherwise `<repo>/.review/<YYYYMMDD>/<slug>/`.

## 2. Run the dynamic workflow

Write a `workflow` script implementing the loop (see
`references/review-workflow.md` for the skeleton and rules):

- **Fix agent** (round ≥ 2): address the previous reviewer's findings against
  the working tree, staying inside the review scope.
- **Review agent**: prompt from `references/prompts/review.md`; call
  `agent()` with a `schema` so it returns `{ verdict: 'pass'|'fix', findings }`
  as structured output.
- On `pass`, return `{ status: 'done', rounds }`. On `fix`, feed the findings
  into the next round. Cap at `maxRounds` (e.g. 8); past the cap return
  `{ status: 'blocked' }`.

## Rules

- Review agents are READ-ONLY: they never modify code.
- Fix agents leave changes UNCOMMITTED (the next round reads the diff).
- Reviewers are adversarial but fair: every finding references a concrete
  location inside the scope and a concrete failure mode.

## Files

- `references/review-workflow.md` — the loop skeleton and scope rules.
- `references/prompts/review.md` — the reviewer role prompt (substitute
  `[[run_dir]]`, `[[repo_root]]`, `[[review_scope]]`).
