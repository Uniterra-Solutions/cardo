# Simplify / Review Workflow (cardo-planmode)

Goal: adversarially review (or simplify) the uncommitted changes for a
plan, looping fix → review until the reviewer passes or the round cap is
hit. One workflow script implements the whole loop.

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

- **Review agent**: `references/prompts/review.md` (adversarial review) or
  `references/prompts/simplify-review.md` (simplification review) — read
  the repo + uncommitted diff (`git status`, `git diff`), then return the
  structured verdict.
- **Fix agent**: your own short prompt that instructs the agent to address
  the previous reviewer's findings against the working tree, referencing
  the plan at `<run_dir>/prd.md`/`design.md` when present.

## Rules

- The review agents are READ-ONLY: they must not modify code.
- Fix agents leave changes UNCOMMITTED (the next review reads the diff).
- Substitute the review prompt's `[[run_dir]]`, `[[repo_root]]`,
  `[[plan_step]]`, and `[[plan_path]]` tokens (see the prompt files).
- `maxRounds` should be modest (e.g. 8); the engine also enforces a hard
  total-agent cap.
- Return structured status only — never partial output as success.
