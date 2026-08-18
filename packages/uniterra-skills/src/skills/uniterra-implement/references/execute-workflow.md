# Execute Workflow (uniterra-implement)

Goal: run the implementation of a complex task by writing a dynamic workflow
script whose shape follows the **task overlap analysis**. The failing
property tests are already on disk (written first — red phase); the subagents
make them green.

## 1. Overlap analysis (decides the mode)

For each task, list the files/modules it will touch (the design doc's
Architecture section names them). Then:

- Build the overlap relation: two tasks **overlap** when their file/module
  sets intersect, or when one depends on the other's output.
- **Full parallel** — no two tasks overlap: every task is independent.
  One batch with every agent; the engine runs them concurrently.
- **Batched** — some tasks overlap: batches run serially, agents WITHIN a
  batch run in parallel. Partition the tasks so overlapping tasks land in
  DIFFERENT batches; tasks that only depend on earlier batches sit in later
  batches. Prefer the smallest batch count that satisfies the partition.
- When the plan produced `execution-plan.json`, its `execution_mode` and
  `batches` already encode this analysis — reuse them (re-verify against the
  current file layout before dispatching).

The workflow script must mirror the chosen shape exactly:

- `parallel`: a single `parallel()` over every agent.
- `batched`: `for` each batch → `parallel(batch.map(a => () => agent(...)))`.

## 2. Agent prompts

Each agent's prompt comes from `references/prompts/execute-agent.md`:

- substitute `[[run_dir]]`, `[[repo_root]]`, `[[task_prompt]]` (the task's
  task_prompt), and `[[requirements]]` (the task's requirements list, one
  bullet per requirement);
- `[[plan_context]]` = the concatenated `## PRD` / `## Design doc` /
  `## Requirements clarification` sections read from the run dir (when a plan
  exists);
- the template auto-injects the plan context; a standalone run substitutes an
  empty section.

An agent returns its final text; a failed child resolves `null`.

## 3. Script skeleton (batched; parallel = single batch)

```js
// meta: { name: 'implement', description: 'Implement the plan agents' }
const { batches, runDir, repoRoot } = args;
const results = [];
for (let b = 0; b < batches.length; b++) {
  phase('batch-' + (b + 1));
  const done = await parallel(
    batches[b].map(
      (a) => () =>
        agent(renderExecuteAgent(a.task_prompt, a.requirements, runDir, repoRoot), {
          label: a.id,
          phase: 'batch-' + (b + 1),
        }),
    ),
  );
  if (done.some((r) => r === null)) return { status: 'failed', batch: b + 1 };
  results.push(...done);
}
return { status: 'done', agents: results.length };
```

## 4. After the workflow

Run the full test suite in the main session. Every failing PBT must be green
before review; red tests are the ONLY acceptable signal that work remains.

## Rules

- Do NOT commit changes; leave the working tree uncommitted so a later review
  phase inspects the diff.
- Respect project conventions: run lint/typecheck/build, add tests, and make
  the red suite turn green.
- Do not modify files outside a task's scope — parallel agents may be
  working at the same time; overlapping files between same-batch agents is a
  planning bug (that is what the overlap partition prevents).
- Cap total agents with a `maxTotalAgents` value consistent with the plan
  size (engine enforces a hard cap regardless).
