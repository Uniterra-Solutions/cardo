# Scenario 2 — Batched (overlapping tasks)

Use when some tasks overlap: their file/module sets intersect, or one depends on another's
output. Batches run serially; agents WITHIN a batch run in parallel.

## Overlap → partition

1. Build the overlap relation from `owned_files` intersections.
2. Partition tasks into the smallest number of batches such that overlapping tasks land in
   DIFFERENT batches; tasks that only depend on earlier batches sit in later batches.
3. `args.batches` is an array of task arrays (not the flat task list) — partition before
   writing the script.

## Script

```js
// meta: { name: 'implement', description: 'Implement overlapping tasks in serial batches' }
const { goal, batches } = args;
const results = [];
for (let b = 0; b < batches.length; b++) {
  phase('batch-' + (b + 1));
  const done = await parallel(
    batches[b].map((t) => () => agent(renderTask(goal, t), { label: t.id, schema: RETURN_SCHEMA })),
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
