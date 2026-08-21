# Workflow Script — shared building blocks

Every script is a plain JavaScript body (no `export const meta` statement — meta rides the
separate `meta` tool parameter). `args` is the task list from `assets/task-list-example.md`.

Submit the assembled script with the `workflow` tool as:
`meta: { name: 'implement', description: '<one line>' }`,
`script: <the assembled JS>`, and `args` = the task list (`{ goal, tasks }` for the
parallel shape, `{ goal, batches }` for the batched shape).

Note: `meta` is a separate required tool parameter, never part of the script. dsh
accepts ONLY `name` and `description` here (plus optional `whenToUse` and `phases`
with only `title`/`detail`/`provider`/`model`) — any other meta field fails the run
with `META_INVALID`.

## Fixed rules (identical in every prompt)

Appended verbatim after the task JSON. These do not vary per task:

```
You are an isolated subagent implementing ONE task of an approved project. You have no
prior conversation context — everything you need is in the JSON below. Do not ask for
clarification; make a reasonable, documented decision where the task is ambiguous.

- Work at the repo root (your cwd). Leave all changes UNCOMMITTED — a later review reads the diff.
- Touch only `constraints.owned_files`; never modify `constraints.forbidden_files` or any file
  outside your task's scope — parallel agents may be working at the same time.
- Your requirement's failing property tests are already written (see `requirements[].test`).
  FIRST prioritize STRENGTHENING / completing those existing failing test cases — extend the
  property, add the missing edge cases and invariant asserts — then make them GREEN. Never
  start by writing a brand-new property test from scratch for a requirement that already has
  an allocated failing test.
- Follow the project's conventions (AGENTS.md / CLAUDE.md): run lint / typecheck / build, add
  tests for new behaviour, and make your requirements' failing property tests GREEN.
- Verify external APIs before using them; never write from memory.
- Record any deviation from the design doc in `deviations`.
```

## Return contract (via `schema`)

```js
const RETURN_SCHEMA = {
  type: 'object',
  required: ['changed_files', 'satisfied_requirements'],
  properties: {
    changed_files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'lines'],
        properties: { file: { type: 'string' }, lines: { type: 'string' } },
      },
    },
    satisfied_requirements: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
  },
};
```

`agent(prompt, { schema: RETURN_SCHEMA })` returns the validated object (or `null` when the
child fails or the shape does not validate).

## Render function

```js
const FIXED_RULES = `…`; // the block above

function renderTask(goal, task) {
  return (
    JSON.stringify(
      {
        goal,
        context: task.context,
        task: {
          name: task.name,
          conventions: task.conventions,
          requirements: task.requirements,
        },
        constraints: task.constraints,
      },
      null,
      2,
    ) +
    '\n\n' +
    FIXED_RULES
  );
}
```

## Minimal complete example (one batch)

```js
const { goal, tasks } = args;

const results = await parallel(
  tasks.map((t) => () => agent(renderTask(goal, t), { label: t.id, schema: RETURN_SCHEMA })),
);

if (results.some((r) => r === null)) return { status: 'failed' };
return { status: 'done', agents: results.length };
```

For the full-parallel and batched skeletons, see `references/parallel-workflow.md` and
`references/batched-workflow.md`.
