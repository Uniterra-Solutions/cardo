# Scenario 1 — Full parallel (independent tasks)

Use when NO two tasks overlap: their `owned_files` sets are disjoint and none depends on
another's output. This is the default when the design cleanly separates modules.

The script is fixed — see `assets/workflow-template.md`. You do NOT write a script here; you
only choose the orchestration shape by setting `args.tasks` (flat array) instead of
`args.batches`, and copy the template's script verbatim.

## Decomposition

1. List each task's files/modules from the design doc's architecture section.
2. Verify the `owned_files` sets are pairwise disjoint. If any two intersect, use the
   batched scenario instead.
3. Each task's `forbidden_files` = every OTHER task's `owned_files` (the partition must be
   complete so parallel agents never collide).
4. Render each task into a markdown `prompt` (see `assets/task-list-example.md`), so `args`
   stays flat.

## `args` shape

```json
{
  "goal": "...",
  "tasks": [{ "id": "T1", "name": "...", "prompt": "...markdown..." }]
}
```

Use exactly one of `tasks` or `batches` — never both. Set `tasks` (flat) for the parallel
shape.

## Watch for

- A `null` result means that child failed (or its return did not validate) — it fails the
  run; do not silently continue.
- Same-batch `owned_files` overlap is a decomposition bug — re-check the file sets before
  dispatching.
- The subagent **returns JSON** (via `schema`); only its **input prompt** is markdown.
