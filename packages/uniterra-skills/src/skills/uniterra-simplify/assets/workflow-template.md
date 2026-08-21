# Simplify Workflow Template

One workflow: review → fix. Submit it with the `workflow` tool as:
`meta: { name: 'simplify', description: 'Behaviour-preserving simplification: review → fix until simple' }`,
`script: <the JS below>`, and `args = { goal, context }` where
`context = { requirements, design, acceptance }` (each may be empty). The two
embedded prompts mirror `references/review-agent.md` and `references/fix-agent.md`.
The `design` context is authoritative: a simplification that contradicts the
plan's architecture or engineering needs is never proposed (review) and never
applied (fix).

Note: `meta` is a separate required tool parameter, never part of the script. dsh
accepts ONLY `name` and `description` here (plus optional `whenToUse` and `phases`
with only `title`/`detail`/`provider`/`model`) — any other meta field fails the run
with `META_INVALID`. `args` may carry an optional `maxRounds`.

```js
const { goal, context } = args;

const REVIEW_PROMPT = `You are an isolated code-simplification reviewer. You have no prior conversation
context — everything you need is in this prompt. Your job is to find how the code
can be simplified WITHOUT changing behaviour. The goal and context are injected
below.

Authoritative constraints — the design is binding:
The Design context block is the plan's architecture. It is AUTHORITATIVE, not a
suggestion.
- A simplification opportunity exists ONLY if it preserves the architecture and
  engineering needs stated in the design: module boundaries, layers, interfaces,
  data shapes, testability, observability, security, error handling, performance,
  extensibility.
- Machinery the design explicitly requires — a layer, an interface, a config
  flag, a guard, an error path — is NOT over-engineering. Do not flag it.
- A checklist match below is an opportunity only when the design is silent on the
  matter and the requirements do not demand the machinery.
- Engineering needs are not speculative features: testability seams, observability
  hooks, and error handling that the design or requirements name are justified by
  definition.
- Never propose a simplification that would require changing the design or
  weakening an engineering need.

Focus — look for these simplification opportunities:
- redundant code and duplicated logic;
- over-engineering and needless abstractions;
- dead code and unused paths;
- unnecessary complexity that the requirements do not demand.

Over-engineering checklist — check each change against these; a match is an
opportunity ONLY when it does not conflict with the authoritative design
constraints above (design-mandated machinery is not over-engineering):
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

Do not propose a simplification that contradicts the design context; a change the
design mandates or that weakens a stated engineering need is not a simplification
opportunity — omit it entirely.

Verdict — decide pass vs fail:
- pass — the code is already as simple as it should be: no recommendations, or
  only trivial/nitpick-level ones whose churn is not worth the benefit. Do NOT
  fail a review over cosmetic nits.
- fail — at least one recommendation with real simplification value that should
  be applied.

Return a verdict ("pass" | "fail") and a structured recommendations list. Each
recommendation carries an id, a safetiness rating (safe | risky), and a
description (what to change + where). If the code is already as simple as it
should be — or every apparent simplification would violate the design context —
return verdict "pass" with an empty list.`;

const FIX_PROMPT = `You are an isolated subagent. You apply simplification recommendations while
preserving behaviour exactly. You have no prior conversation context — everything
you need is in this prompt. The goal, context, and recommendations are injected
below.

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
- The design context is authoritative: if a recommendation contradicts the
  architecture or engineering needs stated in the Design block, do NOT apply it
  — report it skipped with reason "violates design".
- Do NOT introduce new abstractions or change public APIs.
- Leave changes UNCOMMITTED.

Return: status ("fixed" | "failed"), applied_recommendations (the ids applied,
including risky ones that passed their equivalence tests), skipped (a list of
{ id, reason } for the ones NOT applied — only a genuine reason: an equivalence
test failed and the change was reverted, or the code is already in the
recommended shape), and a short summary.`;

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'recommendations'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
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
  if (review.verdict === 'pass' || recommendations.length === 0)
    return {
      status: 'done',
      rounds: round,
      verdict: review.verdict,
      recommendations,
      skipped: accumulatedSkipped,
    };

  // Stage 2 — fix
  const fix = await agent(
    FIX_PROMPT +
      '\n\n## Goal\n' +
      goal +
      '\n\n' +
      contextBlock() +
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
- `verdict` — the last review round's verdict ("pass" | "fail").
- `recommendations` — the last review round's recommendations. When `verdict` is
  "pass", these are trivial/non-blocking ones the reviewer chose not to push (may
  be empty); when "fail", the recommendations that went to fix.
- `skipped` — the accumulated recommendations that were considered but not applied
  (id + reason + round), carried across rounds and never dropped.
- `status: 'done'` — a review round returned `verdict: 'pass'` (already simple;
  any trivial non-blocking recommendations are returned but not applied); any
  residual items are in `skipped`.
- `status: 'blocked'` — the round cap was hit with recommendations still open.
- `status: 'failed'` — the fix agent could not apply a recommendation.
