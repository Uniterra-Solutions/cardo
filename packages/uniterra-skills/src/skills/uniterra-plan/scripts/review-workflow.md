# Review Workflow — fixed script (three parallel review agents)

A fixed workflow script: it reviews `prd.md`, `design.md`, and `acceptance.md` with
three parallel agents. Only the three directory paths vary; the prompts are fixed
(mirrors of `prompts/requirement-list-review.md`, `prompts/design-review.md`, and
`prompts/acceptance-review.md`).

Submit it with the `workflow` tool using `meta: { name: 'plan-review', description:
'Review plan documents with three parallel agents' }` and
`args: { prd_dir, design_dir, acceptance_dir }`.

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

function inputs() {
  return [
    '## Inputs',
    `- prd_dir: ${prd_dir}`,
    `- design_dir: ${design_dir}`,
    `- acceptance_dir: ${acceptance_dir}`,
  ].join('\n');
}

const [requirement, design, acceptance] = await parallel([
  () =>
    agent(REQUIREMENT_PROMPT + '\n\n' + inputs(), {
      label: 'requirement-list-review',
      schema: REVIEW_SCHEMA,
    }),
  () => agent(DESIGN_PROMPT + '\n\n' + inputs(), { label: 'design-review', schema: REVIEW_SCHEMA }),
  () =>
    agent(ACCEPTANCE_PROMPT + '\n\n' + inputs(), {
      label: 'acceptance-review',
      schema: REVIEW_SCHEMA,
    }),
]);

const pass = [requirement, design, acceptance].every((r) => r !== null && r.verdict === 'pass');
return { pass, requirement, design, acceptance };
```

## Reading the result

- `pass: true` → all three reviews are clean; hand off to `uniterra-implement`.
- `pass: false` → apply each agent's `issues` to the corresponding doc, then re-run.
- A `null` slot means that agent failed to return a valid report — treat as `fail`.
