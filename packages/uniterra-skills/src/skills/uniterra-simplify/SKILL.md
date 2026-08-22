---
name: uniterra-simplify
description: >
  Company-standard simplification review on DeepSeek Harness. Usable whenever
  there is a review scope — no plan required. Assemble the goal + context
  (requirements, design, acceptance — from docs or your own input), then run a
  simplify workflow: a review agent finds simplification opportunities (each
  rated safe / risky), and a fix agent applies them while preserving behaviour.
  LOAD when:
  - User asks to simplify code, cut over-engineering, or reduce complexity
    (simplify / 簡化 / 精簡 / 重構減量)
  - User asks to run the simplify phase after implementation
  Do NOT use for adversarial correctness review (uniterra-review), planning
  (uniterra-plan), or implementing (uniterra-implement).
---

# Uniterra Simplify — behaviour-preserving simplification

Pipeline position: after `uniterra-implement`, or standalone. The review is
driven by a goal + three context blocks (requirements, design, acceptance) —
NOT by `execution-plan.json`.

## 1. Assemble goal and context

- **goal** — one line: what the change should achieve.
- **context.requirements** — the requirements list.
- **context.design** — the architecture/design.
- **context.acceptance** — the acceptance criteria list.

These may come from the plan docs (`prd.md`, `design.md`, `acceptance.md`) or be
written by you directly for simple tasks. Any block may be empty.

The `design` block is AUTHORITATIVE: the simplification must never contradict the
plan's architecture or engineering needs. Design-mandated machinery (layers,
interfaces, config flags, guards, error paths) and stated engineering needs
(testability, observability, security, error handling, performance) are not
over-engineering — never propose removing them.

## 2. Run the simplify workflow

Use `assets/workflow-template.md` with the `workflow` tool as **ONE call** whose `arguments`
is a single object with `meta` + `script` + `args` together (never split across parallel
calls, never wrapped in a field named `arguments`). `args = { goal, context }`. Two stages:

1. **review agent** (`references/review-agent.md`) — finds simplification
   opportunities against the over-engineering checklist
   (`references/overengineering-checklist.md`); returns a verdict (`pass` |
   `fail`) plus recommendations, each rated `safe` or `risky`.
2. **fix agent** (`references/fix-agent.md`) — applies the recommendations while
   preserving behaviour exactly.

The workflow loops **review → fix → re-review** until a review round returns
`verdict: 'pass'` (no recommendations, or only trivial non-blocking ones), or the
round cap (`maxRounds`, default 8) is hit.

A `pass` verdict means the code is already simple enough — the reviewer judged
any remaining ideas trivial, so they are returned with the result but NOT
applied. `fail` means at least one recommendation has real value and goes to the
fix agent.

The subagent **reports to the workflow as JSON** (validated by the `schema` each
`agent(...)` call passes); only the subagent **input prompts** are text.

Recommendations a fix round cannot apply (the `skipped` list) are carried into the
next review round and **accumulate** — the reviewer always sees the full skip
history (id + reason + round) and re-raises an item only when its reason no longer
applies. Skipped items are never dropped and are returned with the result.

## Safety levels

- **safe** — the simplification provably preserves behaviour (dead code, identical
  duplication, a redundant abstraction).
- **risky** — the simplification may alter behaviour; needs tests or judgment.

## Rules

- Review agents are READ-ONLY.
- Fix agents leave changes UNCOMMITTED and preserve behaviour exactly.
- A `risky` recommendation must be pinned by equivalence tests BEFORE it is
  applied — never skipped merely for being risky.
- The `design` context is authoritative: never propose a simplification that
  contradicts the plan's architecture or engineering needs. Design-mandated
  machinery and stated engineering needs are not simplification opportunities;
  the checklist applies only where the design is silent.

## Files

- `assets/workflow-template.md` — the review → fix workflow script.
- `references/review-agent.md`, `references/fix-agent.md` — the two agent prompts.
- `references/overengineering-checklist.md` — the focus checklist of common
  AI-agent over-engineering mistakes.
