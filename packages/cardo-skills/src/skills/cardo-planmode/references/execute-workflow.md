# Execute Workflow (cardo-planmode)

Goal: run an approved `execution-plan.json` by writing a dynamic workflow
script that mirrors its batch structure.

## How to write the script

Read `<run_dir>/execution-plan.json`. The batches define the execution
graph — write a `workflow` script where each batch is a `parallel()` of
`agent()` calls, and batches run sequentially:

- `serial` / `batched`: `for` each batch → `parallel(batch.map(a => () =>
agent(promptFor(a), { label: a.id, phase: 'batch-' + (i+1) })))`.
- `parallel`: a single `parallel()` over every agent.

Each agent's prompt comes from `references/prompts/execute-agent.md`:

- substitute `[[run_dir]]`, `[[repo_root]]`, and `[[task_prompt]]` (the
  agent's task_prompt from the JSON);
- the template auto-injects the PRD + design doc context into the prompt;
- `[[plan_context]]` = the concatenated `## PRD` / `## Design doc` /
  `## Requirements clarification` sections read from the run dir.

An agent returns its final text; a failed child resolves `null`.

## Script skeleton

```js
// meta: { name: 'execute', description: 'Execute the plan agents' }
const { batches, runDir, repoRoot } = args;
const results = [];
for (let b = 0; b < batches.length; b++) {
  phase('batch-' + (b + 1));
  const done = await parallel(
    batches[b].map(
      (a) => () =>
        agent(renderExecuteAgent(a.task_prompt, runDir, repoRoot), {
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

## Rules

- Do NOT commit changes; leave the working tree uncommitted so a later
  review phase inspects the diff.
- Respect project conventions: run lint/typecheck/build, add tests, and
  make the plan's failing PBTs turn green.
- Do not modify files outside a task's scope — parallel agents may be
  working at the same time.
- Cap total agents with a `maxTotalAgents` value consistent with the plan
  size (engine enforces a hard cap regardless).
