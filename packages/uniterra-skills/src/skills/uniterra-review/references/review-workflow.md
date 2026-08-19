# Review Workflow (uniterra-review)

Goal: adversarially review the uncommitted changes (or a narrower scope) for
a plan, looping fix → review until the reviewer passes or the round cap is
hit. One workflow script implements the whole loop.

## Scope

- Default scope: the uncommitted changes (`git status`, `git diff`).
- Narrower scope (user-specified): substitute the exact files/refs into
  `[[review_scope]]` — e.g. "only `src/foo.ts` and `src/foo.test.ts`
  (`git diff -- src/foo.ts src/foo.test.ts`)" or "only the last commit's
  changes (`git diff HEAD~1`)".
- The reviewer inspects ONLY the scope. Findings outside it are out of
  bounds and must not drive fixes.

## The loop

The loop is **repro-first**: a finding is pinned as a FAILING test before the
fix agent touches source. This is the only thing that keeps a fix agent from
"fixing" a false positive by over-engineering (the #1 failure mode).

```
for round in 1..maxRounds:
  verdict = review(round)              # read-only; prompts/review.md
  if verdict.verdict == 'pass': return { status: 'done', rounds: round }
  findings = verdict.findings

  repro = agent(reproPrompt(findings, round), { label: 'repro-'+round, phase: 'repro' })
  if repro is null: return { status: 'blocked', reason: 'repro agent failed', lastVerdict: 'fix', lastFindings: findings }

  fix = agent(fixPrompt(findings, round), { label: 'fix-'+round, phase: 'fix' })
  if fix is null: return { status: 'blocked', reason: 'fix agent failed', lastVerdict: 'fix', lastFindings: findings }

return { status: 'blocked', reason: 'max rounds reached', lastVerdict: 'fix', lastFindings: findings }
```

Every `blocked` return MUST carry `lastFindings` (and `lastVerdict`) — a bare
`{ status: 'blocked' }` discards the reviewer's work and wastes the round.

## Prompts

- **Review agent**: `references/prompts/review.md` — read the repo and the
  scope, try to BREAK the changes (bugs, security holes, race conditions,
  correctness gaps, contract violations against the plan's requirements when
  a plan exists), verify platform/OS/API-behavior claims against source, then
  return the structured verdict.
- **Repro agent**: for each finding, add a FAILING test that captures it and
  run the suite to confirm it FAILS (red). Pure-function findings → the
  package's `*.test.mts`/`*.mjs` (fast-check property or deterministic
  regression); I/O/timing findings → the closest deterministic regression.
  Do NOT edit source. (Discipline: `uniterra-pbt-debugging`.)
- **Fix agent**: make ONLY the failing repro tests pass (green), minimal
  change, inside the scope, uncommitted. Include the constraints below.

## Fix-agent constraints (verbatim in the fix prompt)

- Make the MINIMAL source change so the failing repro tests pass (green).
- Do NOT delete or weaken the repro tests.
- Do NOT refactor unrelated code, add abstractions/dependency injection, or
  change copy/rename/platform semantics unless a finding specifically demands it.
- Run the test suite and lint before reporting done.

## Rules

- The review agents are READ-ONLY: they must not modify code.
- Repro agents add FAILING tests only; they never modify source.
- Fix agents leave changes UNCOMMITTED (the next review reads the diff).
- Substitute the review prompt's `[[run_dir]]`, `[[repo_root]]`, and
  `[[review_scope]]` tokens (see the prompt file).
- `maxRounds` is a safety net, not a completion signal: `done` = reviewer
  passed; `blocked` = cap hit AND findings returned. Treat `blocked` with
  findings as "still has findings", never as success.
- Return structured status + `lastFindings` — never partial output as success.
