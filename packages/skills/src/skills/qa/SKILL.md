---
name: qa
description: >
  Standalone PRD-driven acceptance testing across all app types. Extracts
  every user-facing requirement from the PRD as a testable user journey and
  exercises each as a real user — browser for web, terminal for CLI/API,
  computer-use for desktop, execute_code for libraries. Finds issues, fixes
  them immediately with regression tests, and loops until all requirements
  pass. Produces a QA report mapping requirements to evidence.
  LOAD when:
  - User says "qa" or "test" or "驗收" or "試用"
  - User asks to verify a working app against its PRD or requirements
  Do NOT use for:
  - Unit or integration testing (developer's job, not acceptance testing)
  - Performance or load testing
---

# QA — Standalone Acceptance Testing

## Goal

Verify a working app against its PRD by exercising every user-facing
requirement as a complete user journey. Find bugs, fix them immediately
with regression tests, re-run the journey, and repeat until every
requirement produces the expected outcome. Finish with a QA report that
maps each requirement to the evidence proving it works.

Standalone: works on any app and any repository, with no external
framework required. You are the tester, the fixer, and the reporter.

## Acceptance Criteria

- Every PRD user-facing requirement exercised as a journey (not an isolated check)
- Each journey: ✅ PASS or 🔴 FAIL with evidence
- Issues found → fixed immediately + regression test + journey re-run
- QA report maps every requirement → journey → outcome → evidence
- Unfixable issues escalated with reproduction steps (never guessed at)

## Core Principles

**PRD is the contract.** Every user-facing requirement becomes a user
journey. "Users can register with email" becomes: signup → confirm → login
→ dashboard → logout. Exercise the full journey, not just the signup
endpoint.

**Flows, not features.** A page test says "login works." A journey says
"register → confirm email → login → see correct dashboard → logout."
Bugs live between the steps.

**Fix immediately.** Don't just report — fix, add a regression test,
re-run the journey. Iterate until it passes. Only escalate when the fix
needs a design decision, missing infrastructure, or an ambiguous spec.

**App-type agnostic.** Auto-detect the app type and use the right tools:
web → browser, CLI → terminal, API → curl, desktop → computer-use,
libraries → execute_code. See `references/app-type-examples.md` for
tool-specific patterns.

**Evidence for every verdict.** Pass or fail, capture the proof:
screenshots (web), terminal output (CLI/API), response dumps (API).

## Workflow

### Phase 1: Detect App Type

Read the PRD + design. Determine the app type (web, CLI, API, desktop,
library, or hybrid). If uncertain, ask the user. Choose the toolset per
`references/app-type-examples.md`.

### Phase 2: Extract Requirements

Extract every user-facing requirement from the PRD. The PRD is the source
of truth: requirements in the PRD missing from the app are bugs; behavior
not in the PRD is out of scope unless the user adds it.

### Phase 3: Build the Journey Matrix

For each requirement, define a complete user journey: entry point, every
step, every branch (validation errors, empty states, permission denied),
every side effect, and the true end state. Map requirement → journey →
expected outcomes. Prioritize: critical flows first, then secondary, then
edge cases.

### Phase 4: Start the App

Detect the run command from project config (package.json scripts, Makefile,
README.md). Start in background, wait for the ready signal. Use one server
instance for the entire run — don't restart between journeys.

### Phase 5: Execute + Fix Loop

For each journey in priority order:

1. Announce the journey, execute every step with the right toolset
2. ✅ PASS → capture evidence, move on
3. 🔴 FAIL → diagnose the source → fix the code → add a regression test →
   re-run the journey from step 1 → iterate
4. Unfixable (design flaw, missing infra, ambiguous spec) → escalate with
   reproduction steps, move on

### Phase 6: Report

Write `.plan/<DD-MM-YYYY>/<name>/qa-report.md`:

```markdown
# QA Report — {{plan-name}}

## Summary
| Metric | Count |
|--------|-------|
| Total journeys | N |
| Passed | X |
| Failed → Fixed | Y |
| Escalated | Z |

## Journey Results
For each journey: verdict, toolset, evidence reference, fixes applied,
regression tests added.

## Escalations
For each: which requirement, what's broken, why it can't be fixed here,
recommendation.
```

## Evidence Requirements

- Every verdict cites concrete evidence: screenshot path (web), terminal
  output (CLI/API), response dump (API), code change + test (fixes)
- Evidence is reproducible — include the exact command, URL, or input used
- Every fix ships with a regression test that proves the bug is gone
- No verdict without evidence; the QA report links each requirement to its
  evidence

## Gotchas

- **Journeys, not unit tests.** A unit test checks `create_user()` returns
  an ID. A journey checks register → confirm → login → see correct data →
  logout. The gaps between steps are where bugs hide.
- **One server instance, entire run.** Don't restart between journeys.
- **Test data hygiene.** Use unique identifiers per journey so they don't
  collide. Clean up after each journey or at the end.
- **Realistic test data.** No "test", "foo", "123". Realistic names/emails
  surface rendering and validation issues better.
- **Console errors are bugs.** Even if the UI looks fine, a red console is
  a finding. Check after every interaction.
- **Empty states break most often.** Test every list with zero items, every
  dashboard with a new user.
- **Escalate, don't guess.** If the cause is unclear or the fix needs a
  design decision, escalate with reproduction steps. Don't assume what the
  behavior should be.
- **PRD is source of truth.** If behavior ≠ PRD, flag it. Either the code
  is wrong (fix) or the PRD is wrong (update). Never silently accept the gap.

## References

- `references/app-type-examples.md` — Tool-specific commands for each
  app type (browser, terminal/curl, computer-use, execute_code).
