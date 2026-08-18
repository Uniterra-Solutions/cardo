---
name: uniterra-qa
description: >
  Standalone PRD-driven acceptance testing across all app types. For UI apps:
  verify DOM geometry with the playwright-backed browser tools, screenshot
  every key state and pixel-analyze the images to confirm the appearance is
  correct, then exercise each feature as a real user journey — via external
  UI-operation tools (computer-use for desktop, app CLIs) when available, or
  playwright end-to-end when they are not. For pure backend apps: replay the
  full install + smoke-boot flow inside a clean container, then test the API.
  Finds issues, fixes them immediately with regression tests, loops until all
  requirements pass, and produces a QA report mapping requirements to
  evidence. LOAD when:
  - User says "qa" or "test" or "驗收" or "試用"
  - User asks to verify a working app against its PRD or requirements
  Do NOT use for:
  - Unit or integration testing (developer's job, not acceptance testing)
  - Performance or load testing
---

# Uniterra QA — Standalone Acceptance Testing

## Goal

Verify a working app against its PRD by exercising every user-facing
requirement as a complete user journey. Find bugs, fix them immediately
with regression tests, re-run the journey, and repeat until every
requirement produces the expected outcome. Finish with a QA report that
maps each requirement to the evidence proving it works.

Appearance comes before function: a screen that looks broken fails QA even
if its buttons work. UI apps are verified visually first (geometry + pixels),
then functionally; backend apps are verified by the full install → boot →
smoke flow inside a clean container.

Standalone: works on any app and any repository, with no external
framework required. You are the tester, the fixer, and the reporter.

## Acceptance Criteria

- Every PRD user-facing requirement exercised as a journey (not an isolated check)
- UI apps: every key screen passes DOM geometry + screenshot pixel analysis
  before its functional journeys run
- Backend apps: clean-container install → build → smoke boot reaches readiness
  before API journeys run
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

**Appearance first, then behaviour.** Visual defects (broken layout, blank
regions, clipped text, overlapping controls) are findings even when every
interaction succeeds. Geometry and pixel checks gate the functional phase.

**Fix immediately.** Don't just report — fix, add a regression test,
re-run the journey. Iterate until it passes. Only escalate when the fix
needs a design decision, missing infrastructure, or an ambiguous spec.

**App-type agnostic, two pipelines.** Auto-detect the app type: UI app
(web / desktop) → visual verification + UI operation; pure backend
(API / CLI service) → container install + smoke boot + API journeys. See
`references/app-type-examples.md` for tool-specific commands.

**Evidence for every verdict.** Pass or fail, capture the proof:
screenshots + pixel notes (UI), terminal output (CLI/API/container),
response dumps (API).

## Workflow

### Phase 1: Detect App Type

Read the PRD + design. Determine the app type and pipeline:

- **UI app** — web app, desktop app, or hybrid with a user-facing surface →
  pipeline A (visual verification, then UI operation).
- **Pure backend** — API service, CLI tool, library with no UI → pipeline B
  (container install + smoke boot, then API/CLI journeys).
- If uncertain, ask the user.

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

- **UI app**: detect the run command from project config (package.json
  scripts, Makefile, README.md). Start in background, wait for the ready
  signal. Use one server instance for the entire run — don't restart
  between journeys.
- **Pure backend**: run it in a **clean container** (see
  `references/app-type-examples.md`): mount the repo, run the install
  exactly as a fresh user would (`--frozen-lockfile` / `CI=true` for pnpm,
  `npm ci`, …), build, then boot to the readiness signal. This phase IS a
  test: an install or boot that fails in the container is a 🔴 FAIL with the
  container log as evidence. After readiness, run every journey against
  this containerized instance.

### Phase 5: Visual Verification (UI apps only — pipeline A)

Before any functional journey, verify that every key screen LOOKS right.
Key screens = the matrix's entry states: initial, empty, filled, error,
and the 375 / 768 / 1280 breakpoints when responsive.

1. **DOM geometry (playwright).** For each key screen: navigate, then
   evaluate geometry checks — no horizontal overflow
   (`scrollWidth ≤ clientWidth`), key elements inside the viewport, no
   zero-size elements that must be visible, interactive hit targets
   ≥ ~24px, no pairwise overlap of primary controls. A failed check is a
   finding with the element and its bounding box cited.
2. **Screenshot + pixel analysis (playwright).** Capture a screenshot of
   each key screen/state. Analyze the image's pixels, not just your
   impression:
   - the image is not blank and content regions are non-empty (no giant
     solid-color blocks where content is expected);
   - no obviously clipped or overlapping text (rows/edges bleeding into
     each other), no broken-image placeholders;
   - the visual matches the PRD's described layout for that state.
     Use image reading for the semantic check and a small pixel-statistics
     script (region brightness/variance, solid-color detection) for the
     mechanical one. Save screenshots as evidence.
3. **Fix loop.** A visual finding goes through the same fix → regression
   test → re-verify cycle as a functional one. Only when geometry AND
   pixels pass does the functional phase start.

### Phase 6: Execute + Fix Loop

For each journey in priority order:

1. Announce the journey, execute every step with the right toolset.
2. ✅ PASS → capture evidence, move on.
3. 🔴 FAIL → diagnose the source → fix the code → add a regression test →
   re-run the journey from step 1 → iterate.
4. Unfixable (design flaw, missing infra, ambiguous spec) → escalate with
   reproduction steps, move on.

**UI apps — how to operate the UI:**

- External tools FIRST: desktop apps → `computer-use` (operate the real
  app); web apps → any project-provided UI-driving tool, CLI, or ops
  endpoint. These exercise the real product, not a test harness.
- No external tool available → **playwright end-to-end**: drive every
  journey through the browser tools (navigate → snapshot → act → verify),
  checking the console after each interaction. Console errors are bugs.

**Pure backend — how to exercise it:**

- API journeys with `curl` against the containerized instance (status
  code + body assertions, error branches included).
- CLI journeys inside the container (exit code + stdout/stderr).
- No UI phase — the install/boot container log IS the visual evidence.

### Phase 7: Report

Write `.plan/<DD-MM-YYYY>/<name>/qa-report.md`:

```markdown
# QA Report — {{plan-name}}

## Summary

| Metric         | Count |
| -------------- | ----- |
| Total journeys | N     |
| Passed         | X     |
| Failed → Fixed | Y     |
| Escalated      | Z     |

## Visual Verification (UI apps)

Per key screen: geometry result, screenshot path, pixel-analysis result.

## Journey Results

For each journey: verdict, toolset, evidence reference, fixes applied,
regression tests added.

## Escalations

For each: which requirement, what's broken, why it can't be fixed here,
recommendation.
```

## Evidence Requirements

- Every verdict cites concrete evidence: screenshot path + pixel notes (UI
  appearance), screenshot path (UI journeys), terminal output (CLI/API/
  container), response dump (API), code change + test (fixes)
- Evidence is reproducible — include the exact command, URL, or input used
- Every fix ships with a regression test that proves the bug is gone
- No verdict without evidence; the QA report links each requirement to its
  evidence

## Gotchas

- **Journeys, not unit tests.** A unit test checks `create_user()` returns
  an ID. A journey checks register → confirm → login → see correct data →
  logout. The gaps between steps are where bugs hide.
- **Appearance is part of acceptance.** A blank region, an overflowing
  layout, or clipped text is a 🔴 FAIL even if the clicks all work.
- **Geometry checks are cheap and catch real bugs.** Horizontal overflow
  and overlapping controls are the two most common layout defects — check
  them on every key screen, not just the landing page.
- **One server/container instance, entire run.** Don't restart between
  journeys (except to re-run after a fix).
- **The container flow tests the install too.** A fresh user hits install
  and boot before any feature; replicate that — locked lockfiles, CI flags,
  no pre-warmed caches.
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
  pipeline: playwright geometry/pixel checks, UI operation tools, and the
  container install + smoke-boot flow.
