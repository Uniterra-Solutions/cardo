# Workflow Script — shared building blocks

Every script is a plain JavaScript body (no `export const meta` statement — meta rides the
separate `meta` tool parameter). `args` is the task list from `assets/task-list-example.md`.

## Submitting the workflow (CRITICAL)

Make **ONE** `workflow` tool call. Your tool-call `arguments` is a single JSON object with
exactly these three named properties — `meta`, `script`, and `args` are **three properties
of one arguments object, never three separate calls**:

```json
{
  "meta": { "name": "implement", "description": "<one line>" },
  "script": "<the JS body from the code block below>",
  "args": { "goal": "...", "tasks": [{ "id": "T1", "name": "...", "prompt": "<markdown>" }] }
}
```

- `meta` + `script` are REQUIRED; `args` is optional.
- **Never split** `meta` / `script` / `args` across multiple parallel `workflow` calls — each
  partial call fails with `missing required property "meta"` / `"script"`.
- **Never wrap** them under a field named `arguments` — that fails with
  `"arguments" must be an object`.
- `script` is plain JS (no `export const meta`); `meta` is plain JSON (never code); `args`
  is the task list. Each subagent returns JSON — the shape is enforced by the
  `schema` passed to `agent(prompt, { schema })`.

Note on `meta`: dsh accepts ONLY `name` and `description` here (plus optional `whenToUse`
and `phases` with only `title`/`detail`/`provider`/`model`) — any other meta field fails
the run with `META_INVALID`. `args` may carry an optional `maxRounds`.

## The `FIXED_RULES` block (identical in every prompt)

Appended verbatim behind every task prompt. These do not vary per task:

```
You are an isolated subagent implementing ONE task of an approved project. You have no
prior conversation context — everything you need is in the prompt below. Do not ask for
clarification; make a reasonable, documented decision where the task is ambiguous.

- Work at the repo root (your cwd). Leave all changes UNCOMMITTED — a later review reads the diff.
- Touch only the files named in your task's `owned_files`; never modify `forbidden_files` or any
  file outside your task's scope — parallel agents may be working at the same time.
- Your requirement's failing property tests are already written (named in `requirements[].test`).
  FIRST prioritize STRENGTHENING / completing those existing failing test cases — extend the
  property, add the missing edge cases and invariant asserts — then make them GREEN. Never
  start by writing a brand-new property test from scratch for a requirement that already has
  an allocated failing test.
- Follow the project's conventions (AGENTS.md / CLAUDE.md): run lint / typecheck / build, add
  tests for new behaviour, and make your requirements' failing property tests GREEN.
- Verify external APIs before using them; never write from memory.
- Record any deviation from the design doc in `deviations`.
```

## Task shape inside `args`

Each task in `args` carries a **pre-rendered markdown `prompt`** — the full instruction
block for that one subagent, already flattened to text. This avoids nesting a deep JSON
object (which is what corrupts the call). Shape:

```js
// parallel:  args = { goal, tasks: [{ id, name, prompt }] }
// batched:   args = { goal, batches: [ [{ id, name, prompt }], ... ] }
```

- `id` — stable identifier, used as the `label`.
- `name` — one-line task name.
- `prompt` — a markdown block rendered at decomposition time from the task's `goal`,
  `context`, `requirements`, `conventions`, and `constraints` (see
  `assets/task-list-example.md` for the fields and a rendered example). It is a **single
  flat string**, not a nested object.

## Fixed rules (appended by the script)

The script appends `FIXED_RULES` (the block above) to every `task.prompt` at run time, so
the JSON they carry in `args` stays flat and small:

```js
const FIXED_RULES = `…`; // the block above
```

## Return contract (via `schema`) — stays JSON

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
child fails or the shape does not validate). **The subagent's report to the workflow is
JSON-structured via this `schema`** — do NOT convert the return to markdown; only the
subagent's _input prompt_ is markdown.

## Minimal complete example (parallel shape)

```js
const { tasks } = args;

const results = await parallel(
  tasks.map(
    (t) => () => agent(t.prompt + '\n\n' + FIXED_RULES, { label: t.id, schema: RETURN_SCHEMA }),
  ),
);

if (results.some((r) => r === null)) return { status: 'failed' };
return { status: 'done', agents: results.length };
```

For the full-parallel and batched skeletons, see `references/parallel-workflow.md` and
`references/batched-workflow.md`.
