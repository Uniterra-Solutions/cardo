---
name: uniterra-review
description: >
  Company-standard adversarial review on DeepSeek Harness. Usable whenever
  there is a review scope — no plan required. Assemble the goal + context
  (requirements, design, acceptance — from docs or your own input for simple
  tasks), then run a review workflow: a review agent grades findings by
  severity (critical / high / medium / low), a repro agent pins the findings as
  failing property tests (invalid findings dropped), and a fix agent repairs
  only the verified findings. LOAD when:
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
template) + `args = { goal, context, task }`. One workflow, three stages:

1. **review agent** (`references/review-agent.md`) — comprehensive adversarial
   review covering correctness AND security (`references/security-checklist.md`);
   returns a verdict (`pass` | `fail`) plus findings graded critical / high /
   medium / low.
2. **repro agent** (`references/repro-agent.md`) — one agent for all findings;
   pins each as a failing property test written as formal regression tests
   following the repo's conventions; un-reproducible findings are INVALID and
   dropped.
3. **fix agent** (`references/fix-agent.md`) — repairs only the verified findings
   under constraints (no weakened tests, no broken business logic).

The workflow loops **review → repro → fix → re-review** until a review round
returns `verdict: 'pass'` (no findings, or only low-severity non-blocking ones),
every finding is an invalid false positive, or the round cap (`maxRounds`,
default 8) is hit.

A `pass` verdict means the change is ready — the reviewer judged every finding
non-blocking, so they are returned with the result but NOT repro'd or fixed.
`fail` means at least one finding must be addressed: it goes to repro → fix, and
the loop re-reviews until it passes.

## Severity levels

- **critical** — wrong results, data loss/corruption, a security hole, or a core
  requirement entirely unmet. Blocks delivery.
- **high** — fails on a common path, violates a stated requirement or acceptance
  criterion, or deviates from the design in a harmful way. Likely user-visible.
- **medium** — fails on an edge/error path, missing or weak test coverage, or a
  clear maintainability debt. Concrete risk, no immediate breakage.
- **low** — style/naming/readability, a harmless design deviation, non-blocking
  suggestions. No correctness impact.

## Rules

- Review and repro agents never modify source (repro only adds failing tests).
- Fix agent leaves changes UNCOMMITTED and never weakens the repro tests.
- Findings must reference a concrete location + failure mode.

## Files

- `assets/workflow-template.md` — the review → repro → fix workflow script.
- `references/review-agent.md`, `references/repro-agent.md`,
  `references/fix-agent.md` — the three agent prompts.
- `references/security-checklist.md` — the focus checklist of common AI-agent
  code-security mistakes.
