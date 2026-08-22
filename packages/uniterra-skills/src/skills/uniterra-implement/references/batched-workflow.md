# Scenario 2 — Batched (overlapping tasks)

Use when some tasks overlap: their file/module sets intersect, or one depends on another's
output. Batches run serially; agents WITHIN a batch run in parallel.

The script is fixed — see `assets/workflow-template.md`. You do NOT write a script here; you
only choose the orchestration shape by setting `args.batches` (array of task arrays) instead
of `args.tasks`, and copy the template's script verbatim.

## Overlap → partition

1. Build the overlap relation from `owned_files` intersections.
2. Partition tasks into the smallest number of batches such that overlapping tasks land in
   DIFFERENT batches; tasks that only depend on earlier batches sit in later batches.
3. `args.batches` is an array of task arrays (not the flat task list) — partition before
   dispatching. Render each task into a markdown `prompt`
   (see `assets/task-list-example.md`), so `args` stays flat.

## `args` shape

```json
{
  "goal": "...",
  "batches": [[{ "id": "T1", "name": "...", "prompt": "...markdown..." }]]
}
```

Use exactly one of `tasks` or `batches` — never both. Set `batches` (array of task arrays)
for the batched shape.

## Watch for

- Earlier batches edit files that later batches also touch; later tasks' `context.files[].read`
  hints may be stale — prefer symbol / heading references over line numbers for exactly this
  reason.
- A `null` in any batch fails the whole run (later batches likely depend on it).
- The subagent **returns JSON** (via `schema`); only its **input prompt** is markdown.
