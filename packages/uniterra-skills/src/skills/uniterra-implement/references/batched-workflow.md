# Scenario 2 — Batched (overlapping tasks)

Use when some tasks overlap: their file/module sets intersect, or one depends on another's
output. Batches run serially; agents WITHIN a batch run in parallel.

## Overlap → partition

1. Build the overlap relation from `owned_files` intersections.
2. Partition tasks into the smallest number of batches such that overlapping tasks land in
   DIFFERENT batches; tasks that only depend on earlier batches sit in later batches.
3. `args.batches` is an array of task arrays (not the flat task list) — partition before
   writing the script. Render each task into a markdown `prompt`
   (see `assets/task-list-example.md`), so `args` stays flat.

## Submitting the workflow (ONE call)

Make **ONE** `workflow` tool call. `meta`, `script`, and `args` are three properties of ONE
arguments object — never three separate calls, and never wrapped under a field named
`arguments`:

```json
{
  "meta": { "name": "implement", "description": "Implement overlapping tasks in serial batches" },
  "script": "<the JS below>",
  "args": {
    "goal": "...",
    "batches": [[{ "id": "T1", "name": "...", "prompt": "...markdown..." }]]
  }
}
```

`meta` + `script` are required; `args` is optional. Splitting `meta`/`script`/`args` across
parallel calls fails with `missing required property "meta"` / `"script"`; wrapping them in
`arguments` fails with `"arguments" must be an object`. `meta` must contain only `name`,
`description` (plus optional `whenToUse`/`phases`).

## Script

```js
const { batches } = args;
const results = [];
for (let b = 0; b < batches.length; b++) {
  phase('batch-' + (b + 1));
  const done = await parallel(
    batches[b].map(
      (t) => () => agent(t.prompt + '\n\n' + FIXED_RULES, { label: t.id, schema: RETURN_SCHEMA }),
    ),
  );
  if (done.some((r) => r === null)) return { status: 'failed', batch: b + 1 };
  results.push(...done);
}
return { status: 'done', agents: results.length };
```

## Watch for

- Earlier batches edit files that later batches also touch; later tasks' `context.files[].read`
  hints may be stale — prefer symbol / heading references over line numbers for exactly this
  reason.
- A `null` in any batch fails the whole run (later batches likely depend on it).
- The subagent **returns JSON** (via `schema`); only its **input prompt** is markdown.
