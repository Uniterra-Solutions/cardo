# Review Workflow Template

One workflow: review → repro → fix. Submit it with the `workflow` tool as:
`meta: { name: 'review', description: 'Adversarial review: review → repro → fix until clean' }`,
`script: <the JS below>`, and `args = { goal, context, task }` where
`context = { requirements, design, acceptance }` (each may be empty). The
three embedded prompts mirror `references/review-agent.md`, `references/repro-agent.md`,
and `references/fix-agent.md`.

Note: `meta` is a separate required tool parameter, never part of the script. dsh
accepts ONLY `name` and `description` here (plus optional `whenToUse` and `phases`
with only `title`/`detail`/`provider`/`model`) — any other meta field fails the run
with `META_INVALID`. `args` may carry an optional `maxRounds`.

```js
const { goal, context, task } = args;

const REVIEW_PROMPT = `You are an isolated adversarial code reviewer. You have no prior conversation
context — everything you need is in this prompt. Your job is to try to BREAK the
changes, not approve them. The goal, task, and context blocks are injected below.

Focus — check for ALL of these:
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

Severity levels:
- critical — wrong results, data loss/corruption, a security hole, or a core
  requirement entirely unmet. Blocks delivery.
- high — fails on a common path, violates a stated requirement or acceptance
  criterion, or deviates from the design in a harmful way. Likely user-visible.
- medium — fails on an edge/error path, missing or weak test coverage, or a clear
  maintainability debt. Concrete risk, no immediate breakage.
- low — style/naming/readability, a harmless design deviation, non-blocking
  suggestions. No correctness impact.

Verdict — decide pass vs fail:
- pass — the code is ready: no findings, or only low-severity non-blocking
  suggestions. Passing is a deliberate judgment call: do NOT fail a review over
  nitpicks — low findings alone never block.
- fail — any finding at medium or above, or any finding (even low) that must be
  addressed before the change is accepted.

Return a verdict ("pass" | "fail") and a structured findings list. Every finding
must reference a concrete location (inside the scope) and a concrete failure
mode, and carry the id, level, and description. If the code is sound, return
verdict "pass" with an empty findings list.`;

const REPRO_PROMPT = `You are an isolated subagent. You reproduce ALL review findings as failing
property-based tests. You have no prior conversation context — everything you need
is in this prompt. The goal and findings are injected below.

Method:
1. For EACH finding, define the business logic under investigation as an invariant.
2. Write a FAILING property test (fast-check, or a deterministic regression) that
   captures the finding.
3. Run the suite to confirm it FAILS for the reason the finding describes (red).

The tests are FORMAL source code that stay in the repo as permanent regression
coverage — follow the repo's test conventions exactly:
- Write each test to the repo's conventional test location for the module under
  test (e.g. the package's test/ directory, in the format the package's test
  script picks up), using the repo's test framework (node:test + fast-check
  where AGENTS.md prescribes it).
- Name each test file and test case DESCRIPTIVELY after the invariant it pins
  (e.g. <module>-<behaviour>.test.mjs), never after a finding id.
- Match the repo's existing conventions (imports, formatting, assertion style)
  so the tests pass lint/format like any other source.
- If a regression test for an invariant already exists (e.g. from an earlier
  round), do not duplicate it — re-run it and confirm it still fails for the
  finding's reason.

Reproducible vs invalid:
- verified — the test reproduces the finding (fails for the described reason).
- invalid — you cannot reproduce it: the code is correct, the finding is wrong, or
  the behaviour cannot be pinned by a test. Do NOT write a test that fails for an
  unrelated reason just to "confirm" it.

Do NOT edit source — only add the failing tests.

Return: results — one entry per finding: id (unchanged), verdict ("verified" | "invalid"),
level (unchanged), verification_test (the test file path — only when verified), and
description.`;

const FIX_PROMPT = `You are an isolated subagent. You repair ONLY the verified findings, each already
pinned by a failing test. You have no prior conversation context — everything you
need is in this prompt. The goal and verified findings are injected below.

Method:
1. Make the MINIMAL source change so each verified finding's failing test passes
   (green).
2. Run the test suite and lint; confirm the pinned tests pass and nothing else broke.

Constraints:
- Do NOT delete or weaken the repro tests.
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
        required: ['id', 'level', 'description'],
        properties: {
          id: { type: 'string' },
          level: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
        },
      },
    },
  },
};

const REPRO_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict', 'level', 'description'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['verified', 'invalid'] },
          level: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          verification_test: { type: 'string' },
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
    fixed_findings: { type: 'array', items: { type: 'string' } },
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

for (let round = 1; round <= maxRounds; round++) {
  phase('round-' + round);

  // Stage 1 — review
  const review = await agent(
    REVIEW_PROMPT + '\n\n## Goal\n' + goal + '\n\n## Task\n' + task + '\n\n' + contextBlock(),
    { label: 'review-' + round, schema: REVIEW_SCHEMA },
  );
  if (review === null) return { status: 'blocked', reason: 'review agent failed', round };
  const findings = review.findings;
  if (review.verdict === 'pass' || findings.length === 0)
    return { status: 'done', rounds: round, verdict: review.verdict, findings };

  // Stage 2 — repro (one agent for all findings)
  const repro = await agent(
    REPRO_PROMPT + '\n\n## Goal\n' + goal + '\n\n## Findings\n' + JSON.stringify(findings, null, 2),
    { label: 'repro-' + round, schema: REPRO_SCHEMA },
  );
  if (repro === null) {
    return { status: 'blocked', reason: 'repro agent failed', round, findings };
  }
  const verified = (repro.results ?? []).filter((r) => r !== null && r.verdict === 'verified');
  if (verified.length === 0) {
    return { status: 'done', rounds: round, findings: findings.length, invalid: findings.length };
  }

  // Stage 3 — fix
  const fix = await agent(
    FIX_PROMPT +
      '\n\n## Goal\n' +
      goal +
      '\n\n## Verified findings\n' +
      JSON.stringify(verified, null, 2),
    { label: 'fix-' + round, schema: FIX_SCHEMA },
  );
  if (fix === null) return { status: 'blocked', reason: 'fix agent failed', round, verified };
  if (fix.status === 'failed') return { status: 'failed', round, verified };
}

return { status: 'blocked', reason: 'max rounds reached', rounds: maxRounds };
```

## Reading the result

- `rounds` — number of rounds run.
- `verdict` — the last review round's verdict ("pass" | "fail").
- `findings` — the last review round's findings. When `verdict` is "pass", these
  are non-blocking (low-severity) items the reviewer chose not to fix; when
  "fail", the findings that went to repro.
- `status: 'done'` — a review round returned `verdict: 'pass'` (no findings, or
  only low-severity non-blocking ones — those findings are returned but not
  fixed), or every finding was an invalid false positive, so nothing is left to
  fix.
- `status: 'blocked'` — the round cap was hit with findings still open; inspect the last
  round's work.
- `status: 'failed'` — the fix agent could not repair a verified finding.
