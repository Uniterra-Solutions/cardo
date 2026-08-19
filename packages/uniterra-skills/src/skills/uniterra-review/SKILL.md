---
name: uniterra-review
description: >
  Company-standard adversarial review on DeepSeek Harness. Usable whenever
  there is a review scope — no plan required: establish the scope (uncommitted
  changes by default, or the files/refs the user names), then run a
  repro-first loop — review finds bugs, each bug is pinned as a FAILING
  property/regression test, then the fix agent only makes that test pass —
  until the reviewer passes. Small scopes default to a single deep review.
  LOAD when:
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
`references/review-workflow.md` for the skeleton and rules). The loop is
**repro-first** — the fix agent never touches source until the finding is
pinned as a failing test:

- **Review agent**: prompt from `references/prompts/review.md`; call `agent()`
  with a `schema` so it returns `{ verdict: 'pass'|'fix', findings }` as
  structured output. Read-only.
- **Repro agent** (after a `fix` verdict): for each finding, add a FAILING
  property/regression test that captures the defect and run the suite to
  confirm it FAILS (red). Read-only with respect to source.
- **Fix agent**: make ONLY the failing repro tests pass (green), minimal
  change, inside the scope. Leaves changes uncommitted.
- On `pass`, return `{ status: 'done', rounds }`. On `fix`, feed the findings
  into repro → fix and re-review. Cap at `maxRounds` (e.g. 8); past the cap
  return `{ status: 'blocked', lastVerdict: 'fix', lastFindings }` — findings
  must be returned, never dropped.

### Small scope → single deep review

When the scope is small (≤ 3 files, no plan), prefer ONE deep review over the
loop: a single adversarial pass that verifies platform/OS/API-behavior claims
against source catches more than several fix-agent rounds (an unconstrained fix
agent over-engineers). Only enter the repro-first loop if that single review
returns `fix`.

## Rules

- Review agents are READ-ONLY: they never modify code.
- Repro agents add FAILING tests only — they never modify source.
- Fix agents leave changes UNCOMMITTED (the next review reads the diff).
- Fix agents make the MINIMAL change so the repro tests pass: no unrelated
  refactors, no new abstractions/dependency injection, no changed platform
  semantics unless a finding demands it.
- Reviewers verify platform/OS/API-behavior claims against the authoritative
  source (libuv/OS docs/library source) and mark unverifiable claims
  `[UNVERIFIED]`; `[UNVERIFIED]` findings must NOT drive a fix.
- Reviewers are adversarial but fair: every finding references a concrete
  location inside the scope and a concrete failure mode.

## Files

- `references/review-workflow.md` — the loop skeleton and scope rules.
- `references/prompts/review.md` — the reviewer role prompt (substitute
  `[[run_dir]]`, `[[repo_root]]`, `[[review_scope]]`).
