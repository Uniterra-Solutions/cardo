---
name: agentic-debugging
description: >-
  Evidence-driven debugging for bugs, errors, crashes, test failures,
  regressions, and unexpected output. Use when something is broken, not
  working as expected, or producing wrong results — or when the user
  reports a bug, asks to debug/fix an error, or discovers a regression.
  Triggers: bug, error, crash, exception, failure, regression, broken,
  not working, wrong output, unexpected behavior, debug, fix. NOT for:
  feature requests, greenfield development, code review, or assisting a
  human who drives the debugging (→ use systematic-debugging).
---

## Goal

Autonomous bug resolution via a repeatable, evidence-driven loop. The agent
treats debugging as an investigation — each fix is backed by runtime evidence,
not intuition.

## Acceptance Criteria

- Reproduction command exists and is deterministic (or flake rate ≥ 50%)
- Root cause identified with evidence before any code change
- Fix is minimal — one logical change, no bundled refactoring
- All existing tests pass; regression test added for the fix
- No new lint/type errors; all temporary instrumentation removed

## Core Principles

1. **Evidence gates action.** Every root-cause claim needs runtime proof — a log
   line, a stack frame value, a test assertion. "I think" is a hypothesis, not
   a diagnosis.
2. **Reproduce → then fix.** No reproduction, no permission to edit code.
3. **Trace upstream.** The crash site is the symptom. Follow data flow backward
   to the source.
4. **One change, one verify.** Bundled edits hide which change mattered.
5. **Three strikes → question architecture.** Three distinct fix attempts that
   fail mean the bug is structural, not local.

## The Loop

Execute phases in order. Each phase produces evidence the next one consumes.
Bounded to 3 full loop iterations — if you reach Phase 5's "return to Phase 2"
for the third time, escalate to the Rule of Three.

```
1. REPRODUCE  ──▶  2. LOCATE  ──▶  3. HYPOTHESIZE  ──▶  4. FIX  ──▶  5. VERIFY
       ▲                                                                    │
       └────────────────────── (return path) ──────────────────────────────┘
```

**Before starting:** detect the project environment. Note what's available:
git repo? test runner? linter/type-checker? If any are missing, skip the
corresponding Phase gate items — don't block progress on unavailable tools.

---

### Phase 1: REPRODUCE

Build a deterministic command that goes red for this bug and green when fixed.
This is the debugging contract.

**Triage first.** If the bug report lacks a concrete error, reproduction steps,
or expected vs actual behaviour, push back — ask for the missing information
before proceeding. Classify the bug type (logic error, crash, race condition,
performance) to inform later phases.

- Capture the **exact** error (stack trace, exit code, expected vs actual).
  The root cause is often 3-4 frames deep.
- If intermittent, measure the flake rate: run 100×. Flake ≥ 50% is debuggable;
  10–49% needs aggressive instrumentation (add timestamps, widen race windows);
  < 10% requires architectural changes (retry, idempotency, event sourcing).
- Document as: REPRO command, EXPECTED, ACTUAL, FLAKE RATE.

**Phase gate — all must hold before proceeding:**
- Exact error captured (copy-pasted, not paraphrased)
- Reproduction is deterministic or has adequate flake rate
- If no reproduction is possible (prod-only, missing credentials), document the
  constraint and proceed with log-based investigation

---

### Phase 2: LOCATE

Find where the incorrect value originates — not where it crashes.

- Trace data flow backward from the crash site through callers, assignments,
  and configuration.
- **Multi-component systems:** add ONE diagnostic log at each boundary
  (Component A out → Component B in). Run once. The boundary where the value
  goes wrong isolates the failing component.
- Check `git log --oneline -10` and `git log -p --follow <file>` for recent
  changes to the affected path.

**Phase gate:**
- Can state the failing component, file, and approximate line with evidence.
  Format: "Failing location is [file:line] because [runtime observation]."

---

### Phase 3: HYPOTHESIZE

Generate 3-5 candidate root causes before touching code. For each, state:

| Field | Question |
|-------|----------|
| **Cause** | What is wrong and where? |
| **Prediction** | If true, what observable behaviour changes? |
| **Evidence** | What Phase-2 data supports this? |
| **Falsification** | Cheapest test to disprove it |

Rank by likelihood. Test the top hypothesis with a single log line or
assertion — run reproduction once, read output, confirm or reject.

All temporary instrumentation must use a unique prefix for cleanup:
`[DEBUG-a4f2]`. After confirming ONE hypothesis, remove ALL debug lines added
in Phases 2 and 3 before proceeding to Phase 4.

**Phase gate:**
- 3-5 hypotheses with predictions and falsification tests written
- One hypothesis confirmed by runtime evidence
- If all rejected: widen the investigation (expand search radius, instrument
  more boundaries, check config/environment/dependencies, bisect git history),
  then retry Phase 2. Bounded to 2 widen cycles — if still no confirmed
  hypothesis, escalate to Rule of Three.

---

### Phase 4: FIX

Implement the minimal change that addresses the confirmed root cause.

Before editing, write:
```
Root cause: [confirmed hypothesis]
Fix: [file, function, line — one logical change]
Why this works: [causal chain from fix to green reproduction]
Side effects: [what else might this affect?]
```

Rules:
- Exactly one logical change. No refactoring, no lint fixes, no cleanup.
- If the fix touches multiple files, verify these are one change, not several.
- Remove ALL temporary instrumentation. Phase 3 should have cleaned these;
  verify with a project-wide grep:
  `grep -r "DEBUG-[a-z0-9]\{4\}" . --include="*.py" --include="*.ts" --include="*.js"` (adapt extensions to project languages).

**Phase gate:**
- `git diff` shows only the fix, no unrelated edits
- All debug instrumentation removed

---

### Phase 5: VERIFY

Prove the fix works and nothing regressed.

1. Run the exact Phase-1 reproduction command → must pass
2. Run full test suite → must be green
3. Run lint and type-check → must be clean
4. Write a regression test that specifically triggers the root cause
5. Commit with a message linking to the evidence

**If reproduction still fails:** return to Phase 2. Your root-cause location
was wrong — re-trace data flow before forming new hypotheses.

**Phase gate:**
- Reproduction passes
- Full suite passes
- Lint/type clean
- Regression test committed
- All temp instrumentation confirmed removed

---

## The Rule of Three

If three **distinct** fixes fail (different hypotheses, different code paths
touched — not progressive refinement of one hypothesis) → **stop. Do not
attempt a fourth.**

This signals an architectural defect, not a local bug. Signs:
- Each fix exposes new coupling or shared state elsewhere
- Fixes require "massive refactoring" to land
- The bug crosses a boundary that shouldn't exist (e.g., UI knows DB schema)

**Action:** Report to the user: (1) the three failed fixes and why each failed,
(2) the architectural pattern causing the cascade, (3) proposed refactoring
scope — redesign the boundary, don't patch around it.

## Gotchas

- **Agent-authored code needs re-reading.** Agents hallucinate APIs, skip edge
  cases, and import non-existent modules. Read the full file the agent wrote;
  diff against a working reference in the same codebase. If the agent was told
  to run tests but didn't, the first fix is making it run them.
- **Boundary instrumentation isolates multi-component bugs in one run.** Add a
  single log at each component boundary, run once, read the cascade. The
  boundary where the value diverges IS the failing component.
- **Non-deterministic bugs: raise reproduction rate before hypothesizing.**
  Run 100×. Add strategic sleeps to widen race windows for observation, then
  remove them after fixing. A 1% flake is not debuggable — it needs
  architectural changes (retry, idempotency keys).
- **Performance bugs: profile first.** Use `py-spy`, `perf`, or equivalent.
  Isolate to one function before forming hypotheses. Write a microbenchmark;
  never eyeball performance.
- **UI bugs: screenshot + browser console first.** Share a screenshot of the
  broken state. Read the component AND its parent — most rendering bugs are
  wrong props from the parent.
- **Debug session = fresh context.** Long conversations accumulate noise. If
  the agent repeats mistakes or seems confused, start a new session with a
  clean bug report. Delegate large file reads to subagents. Before starting
  fresh, write a checkpoint to `.jovaltus_debug_state.md` containing: the
  REPRO command, Phase 2 location evidence, confirmed hypothesis, and the
  last Phase gate reached — so the new session can resume without redoing work.
- **Third-party dependency bugs.** If the root cause is in a library you
  can't modify, state this explicitly. Options: workaround (wrap the call),
  version pin (upgrade/downgrade), or upstream report (file an issue with
  evidence). The "one logical change" model still applies to the workaround.
- **This skill vs. systematic-debugging.** Use agentic-debugging when the
  agent drives every step autonomously (runs commands, reads output, decides
  next action). Use systematic-debugging when assisting a human who makes
  decisions — the agent proposes, the human confirms. If both trigger, prefer
  this skill for autonomous sessions.

## Red Flags

If you catch yourself thinking any of these — **stop and return to Phase 1:**

| Rationalization | Reality |
|----------------|---------|
| "Quick fix, test manually later" | Untested fixes don't stick |
| "Let me try changing X and see" | Guessing, not debugging |
| "Fix a few things at once" | Can't isolate what worked |
| "I don't fully get why but it passes" | Bug will return |
| "Skip repro, only happens in prod" | No contract = no fix confidence |
| "One more fix" (after 2+ failures) | Rule of Three — question architecture |
| "Refactor while I'm here" | Bundled edits hide the fix |
| Proposing a fix before reading the failing file | Symptom-level thinking |

## Quick Reference

| Phase | Done When |
|-------|-----------|
| **1. REPRODUCE** | Tight, fast, red command exists |
| **2. LOCATE** | Can state "source is [file:line] because [evidence]" |
| **3. HYPOTHESIZE** | One hypothesis confirmed with runtime evidence |
| **4. FIX** | `git diff` shows exactly one logical change, no debug cruft |
| **5. VERIFY** | Repro green, full suite green, lint clean, regression test committed |

## Jovaltus Pipeline Integration

- **Implement:** subagent follows Phases 1-4 to self-correct before reporting
- **Verify:** subagent uses Phase 5 as its core loop (run → find failures →
  trace → fix → repeat)
- **Simplify:** subagent re-runs regression tests to confirm no fix regressions

## References

- Cursor: [Agent Best Practices](https://cursor.com/blog/agent-best-practices) — Debug Mode
- Claude Code: [Best Practices](https://code.claude.com/docs/en/best-practices) — verification loops
- ClaudeKit: [Debugging Workflow](https://getclaudekit.com/blog/guide/development/debugging-workflow)
- SE-ML: [Verification-First Engineering](https://se-ml.github.io/agentic_patterns/07-verification-first/)
- Will Ness: [The Agentic Loop](https://willness.dev/blog/agentic-loop)
