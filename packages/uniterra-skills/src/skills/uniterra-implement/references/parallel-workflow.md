# Scenario 1 — Full parallel (independent tasks)

Use when NO two tasks overlap: their `owned_files` sets are disjoint and none depends on
another's output. This is the default when the design cleanly separates modules.

## Decomposition

1. List each task's files/modules from the design doc's architecture section.
2. Verify the `owned_files` sets are pairwise disjoint. If any two intersect, use the
   batched scenario instead.
3. Each task's `forbidden_files` = every OTHER task's `owned_files` (the partition must be
   complete so parallel agents never collide).
4. Render each task into a markdown `prompt` (see `assets/task-list-example.md`), so
   `args` stays flat.

## Submitting the workflow (ONE call)

Make **ONE** `workflow` tool call. `meta`, `script`, and `args` are three properties of ONE
arguments object — never three separate calls, and never wrapped under a field named
`arguments`:

```json
{
  "meta": { "name": "implement", "description": "Implement independent tasks in parallel" },
  "script": "<the JS below>",
  "args": { "goal": "...", "tasks": [{ "id": "T1", "name": "...", "prompt": "...markdown..." }] }
}
```

`meta` + `script` are required; `args` is optional. Splitting `meta`/`script`/`args` across
parallel calls fails with `missing required property "meta"` / `"script"`; wrapping them in
`arguments` fails with `"arguments" must be an object`. `meta` must contain only `name`,
`description` (plus optional `whenToUse`/`phases`).

## Script

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

## Watch for

- A `null` result means that child failed (or its return did not validate) — treat it as a
  failed run; do not silently continue.
- Same-batch `owned_files` overlap is a decomposition bug — re-check the file sets before
  dispatching.
- The subagent **returns JSON** (via `schema`); only its **input prompt** is markdown.
