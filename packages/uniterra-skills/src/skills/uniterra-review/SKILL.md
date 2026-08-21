---
name: uniterra-review
description: >
  Company-standard adversarial review on DeepSeek Harness. Usable whenever
  there is a review scope — no plan required. Assemble the goal + context
  (requirements, design, acceptance — from docs or your own input for simple
  tasks), then run a review workflow: a single review agent grades findings by
  severity (critical / high / medium / low) and CONFIRMS each one by writing a
  failing test before reporting it — only confirmed findings are reported
  (unconfirmed findings are dropped), and it never reports low-value issues like
  stale docs or comments (it focuses on the code logic itself). A fix agent then
  repairs only the confirmed findings. LOAD when:
  - User asks to review changes, hunt for bugs, or run the review phase
    (review / 審查 / code review)
  - User asks to verify uncommitted work against its requirements
  Do NOT use for simplification review (uniterra-simplify), planning
  (uniterra-plan), or implementing (uniterra-implement).
---

# Uniterra Review — requirements/design/acceptance-driven adversarial review

Pipeline position: after `uniterra-implement`, or standalone. The review is
driven by a goal + three context blocks (requirements, design, acceptance) —
NOT by `execution-plan.json`.

## 1. Assemble goal and context

- **goal** — one line: what the change should achieve.
- **context.requirements** — the requirements list.
- **context.design** — the architecture/design.
- **context.acceptance** — the acceptance criteria list.
- **task** — what to review: the scope (default: uncommitted changes) + focus.

The three context blocks may come from the plan docs (`prd.md`, `design.md`,
`acceptance.md`) OR be written by you directly when no plan exists (simple
tasks). Any block may be empty — the review agent treats an empty block as "no
contract on that axis".

## 2. Run the review workflow

Use `assets/workflow-template.md` with the `workflow` tool: `meta` + `script` (from the
template) + `args = { goal, context, task }`. One workflow, two stages:

1. **review agent** (`references/review-agent.md`) — comprehensive adversarial
   review covering correctness AND security (`references/security-checklist.md`).
   The review and repro agents are merged into one: the review agent CONFIRMS every
   finding before reporting it by writing a failing regression test in the repo's
   conventional test location (descriptive, invariant-based name — never a finding
   id), so only confirmed findings are reported and unconfirmed findings are
   dropped. It does NOT report low-value non-logic issues (stale docs/comments,
   formatting/style nits) — it focuses on the code logic itself. Returns a verdict
   (`pass` | `fail`) plus findings graded critical / high / medium / low, each
   carrying the path of its confirming test.
2. **fix agent** (`references/fix-agent.md`) — repairs only the confirmed findings
   under constraints (no weakened tests, no broken business logic).

The workflow loops **review → fix → re-review** until a review round returns
`verdict: 'pass'` (no confirmed findings, or only confirmed low-severity
non-blocking ones), or the round cap (`maxRounds`, default 8) is hit.

A `pass` verdict means the change is ready — the reviewer judged every confirmed
finding non-blocking, so they are returned with the result but NOT fixed. `fail`
means at least one confirmed finding must be addressed: it goes to fix, and the
loop re-reviews until it passes.

## Severity levels

- **critical** — wrong results, data loss/corruption, a security hole, or a core
  requirement entirely unmet. Blocks delivery.
- **high** — fails on a common path, violates a stated requirement or acceptance
  criterion, or deviates from the design in a harmful way. Likely user-visible.
- **medium** — fails on an edge/error path, missing or weak test coverage, or a
  clear maintainability debt. Concrete risk, no immediate breakage.
- **low** — a confirmed but non-blocking finding with no correctness impact. Rare,
  since style/naming/readability nits are not reported.

## Rules

- The review agent never modifies source (it only adds the failing regression
  tests that confirm its findings).
- The fix agent leaves changes UNCOMMITTED and never weakens the regression tests.
- Findings must reference a concrete location + failure mode.

## Files

- `assets/workflow-template.md` — the review → fix workflow script (review +
  in-agent reproduction merged into one agent).
- `references/review-agent.md`, `references/fix-agent.md` — the two agent prompts.
- `references/security-checklist.md` — the focus checklist of common AI-agent
  code-security mistakes.
