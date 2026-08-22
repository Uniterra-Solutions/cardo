# Review Workflow Template

One workflow: review (with in-agent reproduction) → fix. Make **ONE** `workflow` tool call —
`meta`, `script`, and `args` are three properties of ONE arguments object, never three
separate calls, and never wrapped under a field named `arguments`:

```json
{
  "meta": {
    "name": "review",
    "description": "Adversarial review: confirm findings, then fix until clean"
  },
  "script": "<the JS below>",
  "args": {
    "goal": "...",
    "context": { "requirements": "...", "design": "...", "acceptance": "..." },
    "task": "..."
  }
}
```

`meta` + `script` are required; `args` is optional. Splitting `meta`/`script`/`args` across
parallel calls fails with `missing required property "meta"` / `"script"`; wrapping them in
`arguments` fails with `"arguments" must be an object`. `meta` must contain only `name`,
`description` (plus optional `whenToUse`/`phases`). `args` may carry an optional `maxRounds`.

The two embedded prompts mirror `references/review-agent.md` and `references/fix-agent.md`.

The review agent and the old repro agent are merged into one: the review agent
verifies every finding itself — it writes a failing test that reproduces each finding
and reports ONLY the findings it confirmed. Unconfirmed findings are dropped, never
reported. This is what "repro" used to do; it is now part of the review step.

```js
const { goal, context, task } = args;

const REVIEW_PROMPT = `You are an isolated adversarial code reviewer who CONFIRMS every finding before
reporting it. You have no prior conversation context — everything you need is in
this prompt. Your job is to try to BREAK the changes, not approve them. The goal,
task, and context blocks are injected below.

Review focus — check for ALL of these:
1. Unmet requirements — does the code fail to satisfy any requirement?
2. Harmful design deviation — does the code deviate from the design in a harmful
   way? A deviation that is BETTER than the design is NOT a finding.
3. Acceptance violations — does the code violate any acceptance criterion?
4. Incorrect verification — is anything not correctly verified (missing tests,
   tests that don't actually assert the behaviour, unverified external-API claims)?
5. Security — check every change against the security checklist below.

Security checklist:
1. Injection — SQL/command/code/path built by string interpolation from untrusted input.
2. Prompt injection — untrusted text (tool output, email, web) treated as instructions.
3. Missing/insecure authorization (IDOR) — object fetched by id with no ownership check.
4. SSRF — a "fetch this URL" helper with no scheme/host allow-list.
5. Insecure deserialization — pickle.loads / yaml.load / eval / JSON.parse on untrusted data.
6. Broken auth / session / JWT — alg=none, no signature verify, no exp check, weak tokens.
7. Hardcoded secrets — API keys / passwords / tokens in source or client bundles.
8. Weak crypto / randomness — MD5/SHA1 for secrets, ECB, Math.random() for tokens.
9. Path traversal / unsafe file ops — paths from user input; zip-slip on extraction.
10. Information disclosure — stack traces, internal paths, secrets in logs/errors.
11. Race conditions (TOCTOU) — check-then-act on shared state without atomicity.
12. Insecure dependencies — known-vulnerable library versions.

Read the repo first (AGENTS.md / CLAUDE.md + the source in scope) so findings
reference real code. Inspect ONLY the review scope named in the task.

Confirm EVERY finding before reporting it — only confirmed findings are reported:
A finding is only worth reporting if you can PROVE it. For each candidate finding:
1. Define the business logic under investigation as an invariant.
2. Write a FAILING test (a fast-check property test, or a deterministic regression)
   that captures the finding. The test is FORMAL source code that stays in the repo
   as permanent regression coverage — follow the repo's test conventions exactly:
   - Write it to the repo's conventional test location for the module under test
     (the package's test/ directory, in the format the package's test script picks
     up), using the repo's test framework (node:test + fast-check where AGENTS.md
     prescribes it).
   - Name it DESCRIPTIVELY after the invariant it pins (e.g.
     <module>-<behaviour>.test.mjs), never after a finding id.
   - Match the repo's existing conventions (imports, formatting, assertion style) so
     the test passes lint/format like any other source.
   - If a regression test for an invariant already exists (e.g. from an earlier
     round), do not duplicate it — re-run it and confirm it still fails for the
     finding's reason.
3. Run the test and confirm it FAILS for the reason the finding describes (red).

Report ONLY findings you confirmed with a failing test. DROP any finding you cannot
confirm — an unconfirmed finding is NOT reported, and you must NOT write a test that
fails for an unrelated reason just to "confirm" it.

Do not report non-logic issues — focus on the code logic itself:
- Do NOT report stale / outdated documentation or comments.
- Do NOT report formatting, style, or naming nits.
- Do NOT report cosmetic suggestions with no correctness impact.
If the only issues you can find are this kind, return verdict "pass".

Severity levels:
- critical — wrong results, data loss/corruption, a security hole, or a core
  requirement entirely unmet. Blocks delivery.
- high — fails on a common path, violates a stated requirement or acceptance
  criterion, or deviates from the design in a harmful way. Likely user-visible.
- medium — fails on an edge/error path, missing or weak test coverage, or a clear
  maintainability debt. Concrete risk, no immediate breakage.
- low — a confirmed but non-blocking finding with no correctness impact. Rare, since
  style/naming/readability nits are not reported.

Verdict — decide pass vs fail:
- pass — the code is ready: no confirmed findings, or only confirmed low-severity
  non-blocking ones. Passing is a deliberate judgment call: do NOT fail a review
  over nitpicks — low findings alone never block.
- fail — any confirmed finding at medium or above, or any confirmed finding (even
  low) that must be addressed before the change is accepted.

Return a verdict ("pass" | "fail") and a structured findings list. Every finding
must reference a concrete location (inside the scope) and a concrete failure mode,
and carry the id, level, description, and verification_test (the path of the
failing test that confirms it). If the code is sound, return verdict "pass" with an
empty findings list.`;

const FIX_PROMPT = `You are an isolated subagent. You repair ONLY the confirmed findings, each already
pinned by a failing test written by the review agent. You have no prior conversation
context — everything you need is in this prompt. The goal and confirmed findings are
injected below.

Method:
1. Make the MINIMAL source change so each confirmed finding's failing test passes
   (green).
2. Run the test suite and lint; confirm the pinned tests pass and nothing else broke.

Constraints:
- Do NOT delete or weaken the failing regression tests.
- Do NOT break already-implemented business logic — all other tests must stay green.
- Do NOT refactor unrelated code or add abstractions / dependency injection unless
  a finding specifically demands it.
- Leave changes UNCOMMITTED.

Return: status ("fixed" | "failed"), fixed_findings (the ids you fixed), and a
short summary.`;

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'level', 'description', 'verification_test'],
        properties: {
          id: { type: 'string' },
          level: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          verification_test: { type: 'string' },
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
    fixed_findings: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

// The subagent reports to the workflow as JSON: each agent() call passes a schema and
// returns the validated JSON object. Only the subagent's input prompt is text.

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

for (let round = 1; round <= maxRounds; round++) {
  phase('round-' + round);

  // Stage 1 — review + in-agent reproduction (the review agent confirms each finding)
  const review = await agent(
    REVIEW_PROMPT + '\n\n## Goal\n' + goal + '\n\n## Task\n' + task + '\n\n' + contextBlock(),
    { label: 'review-' + round, schema: REVIEW_SCHEMA },
  );
  if (review === null) return { status: 'blocked', reason: 'review agent failed', round };
  const findings = review.findings;
  if (review.verdict === 'pass' || findings.length === 0)
    return { status: 'done', rounds: round, verdict: review.verdict, findings };

  // Stage 2 — fix the confirmed findings
  const fix = await agent(
    FIX_PROMPT +
      '\n\n## Goal\n' +
      goal +
      '\n\n## Confirmed findings\n' +
      JSON.stringify(findings, null, 2),
    { label: 'fix-' + round, schema: FIX_SCHEMA },
  );
  if (fix === null) return { status: 'blocked', reason: 'fix agent failed', round, findings };
  if (fix.status === 'failed') return { status: 'failed', round, findings };
}

return { status: 'blocked', reason: 'max rounds reached', rounds: maxRounds };
```

## Reading the result

- `rounds` — number of rounds run.
- `verdict` — the last review round's verdict ("pass" | "fail").
- `findings` — the last review round's findings. When `verdict` is "pass", these are
  confirmed but non-blocking (low-severity) items the reviewer chose not to fix; when
  "fail", the confirmed findings that went to fix.
- `status: 'done'` — a review round returned `verdict: 'pass'` (no confirmed findings,
  or only confirmed low-severity non-blocking ones — those findings are returned but
  not fixed), so nothing is left to fix.
- `status: 'blocked'` — the round cap was hit with findings still open; inspect the last
  round's work.
- `status: 'failed'` — the fix agent could not repair a confirmed finding.
