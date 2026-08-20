# Simplify Workflow Template

One workflow: review → fix. Submit with `args = { goal, context }` where
`context = { requirements, design, acceptance }` (each may be empty). The two
embedded prompts mirror `references/review-agent.md` and `references/fix-agent.md`.

```js
const { goal, context } = args;

const REVIEW_PROMPT = `You are an isolated code-simplification reviewer. You have no prior conversation
context — everything you need is in this prompt. Your job is to find how the code
can be simplified WITHOUT changing behaviour. The goal and context are injected
below.

Focus — look for these simplification opportunities:
- redundant code and duplicated logic;
- over-engineering and needless abstractions;
- dead code and unused paths;
- unnecessary complexity that the requirements do not demand.

Over-engineering checklist — check each change against these:
1. Unnecessary abstraction — pass-through wrappers; an interface with one
   implementation; a factory returning one type; service/repository chains that just
   delegate.
2. Premature generalization (YAGNI) — generics / config for cases that don't exist.
3. Design patterns for their own sake — Strategy / Builder / DI where plain code suffices.
4. Premature architecture — extra layers / modules before requirements justify them.
5. Premature optimization — caching / async / pools before measuring.
6. Speculative features — unrequested "future" code, impossible edge cases.
7. Excessive defensiveness — guards for states that cannot occur.
8. Reinventing / unnecessary deps — reimplementing stdlib; a lib for trivial code.
9. Boilerplate ceremony — builders / DTOs / mappers that just copy fields.
10. Copy-paste drift — 3+ near-identical blocks that should be one function.

Safety rating — for each recommendation, rate its safety:
- safe — provably behaviour-preserving (dead code removal, identical duplication,
  a redundant abstraction).
- risky — may alter behaviour or needs tests/judgment to confirm equivalence.

Do not propose a simplification that would change behaviour; if a change MIGHT
change behaviour, mark it risky.

Return a structured recommendations list. Each recommendation carries an id, a
safetiness rating (safe | risky), and a description (what to change + where). If
the code is already as simple as it should be, return an empty list.`;

const FIX_PROMPT = `You are an isolated subagent. You apply simplification recommendations while
preserving behaviour exactly. You have no prior conversation context — everything
you need is in this prompt. The goal and recommendations are injected below.

Method — apply EVERY recommendation; risky ones get a test-first equivalence gate:
1. safe — apply it directly.
2. risky — pin the current behaviour with tests BEFORE changing anything:
   a. Write a behaviour-pinning test capturing the current logic (a fast-check
      property test, or a deterministic equivalence/regression test asserting the
      new shape equals the old logic over generated inputs).
   b. Run it against the CURRENT code and confirm it PASSES (it pins behaviour
      as-is).
   c. Apply the simplification, then run the pinning tests again — they must
      STILL pass. Green = equivalence confirmed.
   d. If a pinning test fails after the change, the simplification altered
      behaviour: REVERT it and report it skipped with the evidence.
3. Run the full test suite and lint; confirm every test still passes.

Constraints:
- Preserve behaviour EXACTLY — no test may change result.
- A risky recommendation is NOT optional: apply it, but only after its
  equivalence is pinned by tests written BEFORE the change. Never skip a risky
  one merely because it needs verification.
- Do NOT introduce new abstractions or change public APIs.
- Leave changes UNCOMMITTED.

Return: status ("fixed" | "failed"), applied_recommendations (the ids applied,
including risky ones that passed their equivalence tests), skipped (a list of
{ id, reason } for the ones NOT applied — only a genuine reason: an equivalence
test failed and the change was reverted, or the code is already in the
recommended shape), and a short summary.`;

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['recommendations'],
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'safetiness', 'description'],
        properties: {
          id: { type: 'string' },
          safetiness: { type: 'string', enum: ['safe', 'risky'] },
          description: { type: 'string' },
        },
      },
    },
  },
};

const FIX_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['fixed', 'failed'] },
    applied_recommendations: { type: 'array', items: { type: 'string' } },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

function contextBlock() {
  return [
    '## Context',
    '### Requirements',
    context.requirements || '(none)',
    '### Design',
    context.design || '(none)',
    '### Acceptance',
    context.acceptance || '(none)',
  ].join('\n');
}

const maxRounds = args.maxRounds ?? 8;
// Skipped recommendations accumulate across rounds — nothing is ever dropped.
const accumulatedSkipped = [];

for (let round = 1; round <= maxRounds; round++) {
  phase('round-' + round);

  // Stage 1 — review (every round sees the full skip history from earlier fix rounds)
  const skippedBlock = accumulatedSkipped.length
    ? '\n\n## Previously skipped recommendations (from earlier fix rounds)\n' +
      'These were considered and deliberately NOT applied. Do NOT re-raise an item ' +
      'unless its reason no longer holds — if the code has since changed so the ' +
      'simplification is now safe, re-raise it with an updated safety rating and a ' +
      'note that the previous reason no longer applies.\n' +
      JSON.stringify(accumulatedSkipped, null, 2)
    : '';
  const review = await agent(
    REVIEW_PROMPT + '\n\n## Goal\n' + goal + '\n\n' + contextBlock() + skippedBlock,
    { label: 'review-' + round, schema: REVIEW_SCHEMA },
  );
  if (review === null)
    return { status: 'blocked', reason: 'review agent failed', round, skipped: accumulatedSkipped };
  const recommendations = review.recommendations;
  if (recommendations.length === 0)
    return { status: 'done', rounds: round, skipped: accumulatedSkipped };

  // Stage 2 — fix
  const fix = await agent(
    FIX_PROMPT +
      '\n\n## Goal\n' +
      goal +
      '\n\n## Recommendations\n' +
      JSON.stringify(recommendations, null, 2),
    { label: 'fix-' + round, schema: FIX_SCHEMA },
  );
  if (fix === null)
    return {
      status: 'blocked',
      reason: 'fix agent failed',
      round,
      recommendations,
      skipped: accumulatedSkipped,
    };
  if (fix.status === 'failed')
    return { status: 'failed', round, recommendations, skipped: accumulatedSkipped };

  // Accumulate this round's skips so the next review round sees them (dedupe by id)
  for (const s of fix.skipped ?? []) {
    const entry = { round, id: s.id, reason: s.reason };
    const existing = accumulatedSkipped.findIndex((e) => e.id === s.id);
    if (existing >= 0) accumulatedSkipped[existing] = entry;
    else accumulatedSkipped.push(entry);
  }
}

return {
  status: 'blocked',
  reason: 'max rounds reached',
  rounds: maxRounds,
  skipped: accumulatedSkipped,
};
```

## Reading the result

- `rounds` — number of rounds run.
- `skipped` — the accumulated recommendations that were considered but not applied
  (id + reason + round), carried across rounds and never dropped.
- `status: 'done'` — a review round returned no new recommendations (already
  simple); any residual items are in `skipped`.
- `status: 'blocked'` — the round cap was hit with recommendations still open.
- `status: 'failed'` — the fix agent could not apply a recommendation.
