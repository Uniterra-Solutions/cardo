# Review Workflow — fixed script (three parallel review agents + a repair agent)

A fixed workflow script: it reviews `prd.md`, `design.md`, and `acceptance.md` with
three parallel agents, then hands the failing axes' issues to a single repair agent
that applies them to the documents itself. A review axis that already passed is
NEVER re-dispatched — as fixes progress, the number of review agents dispatched each
round shrinks from 3 toward 0. Only the three directory paths vary; the prompts are
fixed (mirrors of `prompts/requirement-list-review.md`, `prompts/design-review.md`,
and `prompts/acceptance-review.md`).

Make **ONE** `workflow` tool call — `meta`, `script`, and `args` are three properties of ONE
arguments object, never three separate calls, and never wrapped under a field named
`arguments`:

```json
{
  "meta": {
    "name": "plan-review",
    "description": "Review plan documents, repair issues, and re-review only the failed axes until all pass"
  },
  "script": "<the JS below>",
  "args": { "prd_dir": "...", "design_dir": "...", "acceptance_dir": "..." }
}
```

`meta` + `script` are required; `args` is optional. Splitting `meta`/`script`/`args` across
parallel calls fails with `missing required property "meta"` / `"script"`; wrapping them in
`arguments` fails with `"arguments" must be an object`. `meta` must contain only `name`,
`description` (plus optional `whenToUse`/`phases`). `args` may carry an optional `maxRounds`.

```js
const { prd_dir, design_dir, acceptance_dir } = args;

const REQUIREMENT_PROMPT = `You are an isolated review subagent. You review the requirements list in prd.md
for soundness before implementation. You have no prior conversation context — read the
files under the input paths below.

Focus — check ONLY these two things:
1. Technical feasibility — is every requirement achievable with the project's tech
   stack (or a reasonable, available addition)? Flag anything impossible, speculative,
   or unsupported by evidence.
2. Mutual contradiction — do any two requirements conflict (mutually exclusive), or is
   any single requirement internally inconsistent?

Do not review the architecture (that is the design-review agent's job) or the
acceptance criteria (the acceptance-review agent's job).

Return verdict: "pass" only if the requirements are sound. Otherwise return
verdict: "fail" and one issues entry per finding: cite the requirement id, the
problem, and a suggested fix.`;

const DESIGN_PROMPT = `You are an isolated review subagent. You review the architecture design in design.md
for over-engineering. You have no prior conversation context — read the files under the
input paths below.

Focus — check ONLY these things:
1. Over-engineering — does the design add complexity beyond what the requirements demand?
2. Minimal complexity — is this the simplest design that still satisfies every requirement?
3. Minimal invasiveness — does it change existing code in the least invasive way possible?
4. External libraries — does it introduce necessary libraries that genuinely simplify
   development, and does it AVOID unnecessary ones?

Do not review requirement feasibility (the requirement-list-review agent's job) or the
acceptance criteria (the acceptance-review agent's job).

Return verdict: "pass" only if the design is appropriately minimal. Otherwise return
verdict: "fail" and one issues entry per finding: cite the module or decision, the
problem, and a suggested simplification.`;

const ACCEPTANCE_PROMPT = `You are an isolated review subagent. You review the acceptance criteria list in
acceptance.md for clarity and verifiability. You have no prior conversation context —
read the files under the input paths below.

Focus — check ONLY these things:
1. Clarity — is every acceptance criterion specific and unambiguous enough that a
   reviewer could decide pass/fail without extra interpretation?
2. Objective, verifiable evidence — does every criterion name a concrete, checkable
   piece of evidence (a test, a command output, an observable behavior)? Flag any
   criterion that relies on subjective judgment or has no evidence.

Do not review requirement feasibility (the requirement-list-review agent's job) or the
design (the design-review agent's job).

Return verdict: "pass" only if every criterion is clear and verifiable. Otherwise
return verdict: "fail" and one issues entry per finding: cite the criterion id, the
problem, and a suggested fix.`;

const REPAIR_PROMPT = `You are an isolated repair subagent. You apply the review issues to the plan documents
yourself. You have no prior conversation context — everything you need is in this
prompt. The issues are injected below as a list of { reviewer, doc, dir, issues }.

Method:
1. For EACH entry, read the document named by \`doc\` inside \`dir\` (e.g. read
   \`<dir>/prd.md\`), and apply every issue in its \`issues\` list. Each issue carries
   a \`where\`, a \`problem\`, and a \`suggestion\`.
2. Make the MINIMAL edit that resolves each issue, following the suggestion where it
   is sensible. Preserve the document's existing structure, formatting, and voice.
3. Do NOT touch a document that has no issues this round, and do NOT rewrite unrelated
   content or invent new problems.

Constraints:
- Only apply the listed issues; do not expand scope.
- Keep changes minimal and consistent with the rest of the document.
- Leave the edited documents on disk (do not commit).

Return: status ("fixed" | "failed") and a short summary of what was applied.`;

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['where', 'problem', 'suggestion'],
        properties: {
          where: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
};

const REPAIR_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['fixed', 'failed'] },
    summary: { type: 'string' },
  },
};

// The subagent reports to the workflow as JSON: each agent() call passes a schema and
// returns the validated JSON object. Only the subagent's input prompt is text.

function inputs() {
  return [
    '## Inputs',
    `- prd_dir: ${prd_dir}`,
    `- design_dir: ${design_dir}`,
    `- acceptance_dir: ${acceptance_dir}`,
  ].join('\n');
}

const REVIEWERS = [
  {
    key: 'requirement',
    label: 'requirement-list-review',
    prompt: REQUIREMENT_PROMPT,
    doc: 'prd.md',
    dir: prd_dir,
  },
  {
    key: 'design',
    label: 'design-review',
    prompt: DESIGN_PROMPT,
    doc: 'design.md',
    dir: design_dir,
  },
  {
    key: 'acceptance',
    label: 'acceptance-review',
    prompt: ACCEPTANCE_PROMPT,
    doc: 'acceptance.md',
    dir: acceptance_dir,
  },
];

const maxRounds = args.maxRounds ?? 8;
const passed = new Set();

for (let round = 1; round <= maxRounds; round++) {
  phase('round-' + round);

  // Only re-review the axes that have not passed yet. A passed axis is never dispatched again,
  // so the number of review agents per round shrinks from 3 toward 0 as fixes land.
  const pending = REVIEWERS.filter((r) => !passed.has(r.key));
  if (pending.length === 0) return { status: 'done', rounds: round, pass: true };

  const results = await parallel(
    pending.map(
      (r) => () => agent(r.prompt + '\n\n' + inputs(), { label: r.label, schema: REVIEW_SCHEMA }),
    ),
  );

  const failures = [];
  pending.forEach((r, i) => {
    const res = results[i];
    if (res === null) {
      failures.push({ reviewer: r, issues: [] });
    } else if (res.verdict !== 'pass') {
      failures.push({ reviewer: r, issues: res.issues ?? [] });
    } else {
      passed.add(r.key);
    }
  });

  if (failures.length === 0) return { status: 'done', rounds: round, pass: true };

  // Repair only the axes that actually produced issues; an axis whose agent returned null
  // carries no actionable issues and is simply re-reviewed next round.
  const toRepair = failures.filter((f) => f.issues.length > 0);
  if (toRepair.length > 0) {
    const repairInput = toRepair.map((f) => ({
      reviewer: f.reviewer.key,
      doc: f.reviewer.doc,
      dir: f.reviewer.dir,
      issues: f.issues,
    }));
    const repair = await agent(
      REPAIR_PROMPT + '\n\n## Issues to repair\n' + JSON.stringify(repairInput, null, 2),
      { label: 'repair-' + round, schema: REPAIR_SCHEMA },
    );
    if (repair === null) return { status: 'blocked', reason: 'repair agent failed', round };
    if (repair.status === 'failed') return { status: 'failed', round, failures };
  }
}

return { status: 'blocked', reason: 'max rounds reached', rounds: maxRounds };
```

## Reading the result

- `status: 'done'` and `pass: true` → all three review axes passed; hand off to
  `uniterra-implement`.
- `status: 'done'` is only returned when `pending.length === 0` or a round had no
  failures — a passed axis is never re-dispatched.
- `status: 'failed'` → the repair agent could not resolve a round's issues; inspect the
  round's `failures`.
- `status: 'blocked'` → the round cap was hit with an axis still failing (or an agent
  kept returning `null`); inspect the last round's work.
- `rounds` — number of rounds run. `failures` carries the failing axes (each with its
  `reviewer` and `issues`) for the round that produced them.
