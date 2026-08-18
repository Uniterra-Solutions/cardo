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

```
for round in 1..maxRounds:
  if round > 1:  # first round has nothing to fix yet
      fix = agent(fixPrompt(findings, round), { label: 'fix-'+round, phase: 'fix' })
      if fix is null: return { status: 'blocked', reason: 'fix agent failed' }
  verdict = agent(reviewPrompt(round), {
      label: 'review-'+round, phase: 'review',
      schema: { type: 'object',
                properties: {
                  verdict: { type: 'string', enum: ['pass', 'fix'] },
                  findings: { type: 'string' },
                },
                required: ['verdict', 'findings'] },
  })
  if verdict is null: return { status: 'blocked', reason: 'review agent failed' }
  if verdict.verdict == 'pass': return { status: 'done', rounds: round }
  findings = verdict.findings
return { status: 'blocked', reason: 'max rounds reached' }
```

## Prompts

- **Review agent**: `references/prompts/review.md` — read the repo and the
  scope, try to BREAK the changes (bugs, security holes, race conditions,
  correctness gaps, contract violations against the plan's requirements when
  a plan exists), then return the structured verdict.
- **Fix agent**: your own short prompt instructing the agent to address the
  previous reviewer's findings against the working tree, INSIDE the review
  scope, referencing the plan at `<run_dir>/prd.md`/`design.md` when present.

## Rules

- The review agents are READ-ONLY: they must not modify code.
- Fix agents leave changes UNCOMMITTED (the next review reads the diff).
- Substitute the review prompt's `[[run_dir]]`, `[[repo_root]]`, and
  `[[review_scope]]` tokens (see the prompt file).
- `maxRounds` should be modest (e.g. 8); the engine also enforces a hard
  total-agent cap.
- Return structured status only — never partial output as success.
