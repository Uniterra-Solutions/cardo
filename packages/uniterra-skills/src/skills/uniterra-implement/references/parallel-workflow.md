# Scenario 1 — Full parallel (independent tasks)

Use when NO two tasks overlap: their `owned_files` sets are disjoint and none depends on
another's output. This is the default when the design cleanly separates modules.

## Decomposition

1. List each task's files/modules from the design doc's architecture section.
2. Verify the `owned_files` sets are pairwise disjoint. If any two intersect, use the
   batched scenario instead.
3. Each task's `forbidden_files` = every OTHER task's `owned_files` (the partition must be
   complete so parallel agents never collide).

## Script

Submit with the `workflow` tool as `meta: { name: 'implement', description: 'Implement independent tasks in parallel' }`, `script: <the JS below>`, and `args = { goal, tasks }` (the flat task list). The meta shape above is a separate tool parameter — do not put it in the script.

```js
const { goal, tasks } = args;
const results = await parallel(
  tasks.map((t) => () => agent(renderTask(goal, t), { label: t.id, schema: RETURN_SCHEMA })),
);
if (results.some((r) => r === null)) return { status: 'failed' };
return { status: 'done', agents: results.length };
```

## Watch for

- A `null` result means that child failed (or its return did not validate) — treat it as a
  failed run; do not silently continue.
- Same-batch `owned_files` overlap is a decomposition bug — re-check the file sets before
  dispatching.
