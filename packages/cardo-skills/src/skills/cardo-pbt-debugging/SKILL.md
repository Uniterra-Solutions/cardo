---
name: cardo-pbt-debugging
description: >
  Company-standard property-based debugging workflow: before changing any
  code, define the business logic under investigation as invariants and
  reproduce the bug via property-based testing, then fix and lock with
  regression tests. Use when the user reports a bug, a test fails, or
  behavior is wrong in a codebase with business logic worth pinning.
  LOAD when:
  - User says "debug" / "bug" / "修" / "報告問題" or reports a defect
  - A property-based test fails or the plan demands PBT-first fixes
  - Behavior is wrong and the fix should be locked by tests
  Do NOT use for:
  - Feature work with no defect to reproduce
  - Generic evidence-driven debugging without a business-logic core
    (→ agentic-debugging)
---

# Cardo PBT-Driven Debugging

Before changing any code, complete this workflow **in order**:

## 1. Read and search the business logic under investigation

- Read the relevant modules, not just the failing symptom. Trace the
  symbols: what are the inputs, the pure functions, the state transitions?
- Find the invariants the code must satisfy — the properties that hold for
  every valid input.

## 2. Define the logic as invariants and reproduce via PBT

- Write (or extend) a property-based test that encodes those invariants:
  generate arbitrary inputs and assert the property holds, using the
  project's PBT harness (fast-check / Hypothesis / quickcheck).
- Run it against the current code. It must FAIL — a failing counterexample
  is the reproduction. If it passes, the property does not capture the
  bug; refine it until it fails.
- Keep the failing test as the red phase: it is the acceptance contract
  for the fix.

## 3. Fix the bug, then complete unit/regression tests

- Fix the root cause, not the symptom. The fix must make the PBT green.
- Add or complete unit tests as deterministic regression tests for the
  specific defect — the PBT proves the invariant, the unit test pins the
  concrete case.
- Run the full suite; nothing else may break.

## Rules

- No code changes before step 2 produces a failing reproduction.
- Prefer pinning business logic as properties over only unit tests.
- If the bug cannot be reduced to a property (I/O, timing), fall back to
  the general evidence-driven loop (`agentic-debugging`) but still add a
  regression test for the fix.
