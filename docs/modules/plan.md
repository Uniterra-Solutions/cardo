# Module: plan execution model (`plan.ts` + `plan-json.ts` + `plan-steps.ts` + `plan-mermaid.ts` + `plan-progress.ts`)

**Purpose:** The execution-plan model that drives `execute_plan` — a total parser for the plan agent's JSON, the artifact IO around it, and the pure derivations (steps, mermaid, progress) that every consumer treats as ground truth.

Sources: `plan.ts` (97 LOC), `plan-json.ts` (56 LOC), `plan-steps.ts` (23 LOC), `plan-mermaid.ts` (60 LOC), `plan-progress.ts` (92 LOC). Written for the plan-mode pipeline (replaces the Hermes `tasks.md` DAG).

## The execution plan shape

The plan agent (or the main agent, per the handoff) writes `<run_dir>/execution-plan.json`:

```json
{
  "execution_mode": "batched",
  "batches": [
    [{ "id": "parse", "task_prompt": "Implement the total parser + PBT" }],
    [
      { "id": "mermaid", "task_prompt": "Implement mermaid generation" },
      { "id": "progress", "task_prompt": "Implement the progress machine" }
    ]
  ]
}
```

- **Batch-major DAG:** batches run serially, agents within a batch run in parallel.
- `execution_mode` constrains the batch shape so the graph is fully derivable from the JSON:
  - `serial` — N batches × 1 agent (linear chain)
  - `batched` — M batches × ≥1 agent (serial between batches, parallel within)
  - `parallel` — exactly 1 batch × all agents
- Agent `id` must be mermaid-safe (`/^[A-Za-z0-9_-]+$/`), `task_prompt` must be non-blank; ids must be unique.

## Public API

| Export                 | Signature                                   | Description                                                                    |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `parseExecutionPlan`   | `(input: unknown) => ExecutionPlan \| null` | Total parser — never throws; `null` on any shape violation                     |
| `readExecutionPlan`    | `(runDir: string) => ExecutionPlan \| null` | Reads + parses `<run_dir>/execution-plan.json` (total: missing/invalid → null) |
| `readRunDoc`           | `(runDir, filename) => string`              | Read a run-dir doc file, `''` when absent                                      |
| `readPlanContext`      | `(runDir) => string`                        | PRD + design doc + clarification concatenated (auto-injected agent context)    |
| `deriveExecutionSteps` | `(plan) => string[][]`                      | `plan.batches.map(b => b.map(a => a.id))` — ordered concurrent agent-id sets   |
| `planToMermaid`        | `(plan) => string`                          | Mermaid flowchart source generated FROM the JSON (never parsed)                |
| `createProgress`       | `(plan) => PlanProgress`                    | All agents `pending`                                                           |
| `agentsToRun`          | `(progress) => string[]`                    | Pending ids of the earliest not-fully-done batch; `[]` when complete/in-flight |
| `startRunning`         | `(progress, ids) => PlanProgress`           | Marks ids `running`; throws unless ids ⊆ `agentsToRun`, no duplicates          |
| `markDone`             | `(progress, id) => PlanProgress`            | Marks one agent `done`; throws unless it is `running`                          |
| `isComplete`           | `(progress) => boolean`                     | Every agent `done`                                                             |

## Mermaid output contract (locked by PBT)

- Header `flowchart TD`; one node line per agent; batches with >1 agent render as mermaid `subgraph` blocks, single-agent batches render bare nodes.
- Edges are the full connection between consecutive batches (every agent in batch k → every agent in batch k+1); serial = linear chain, parallel = no edges.
- Labels quote the `task_prompt` and escape it (`\` → `#bsol;`, `"` → `#quot;`, newlines/tabs → space) so hostile prompts never break the graph structure.

## Dependencies

- Inbound: `index.ts` (`execute_plan`, `runPlanExecution`), `prompts.ts` (`renderAgentPrompt` → `readPlanContext`), `plan-mode.ts` (widget initial state).
- Outbound: `node:fs`, `node:path`.

## Patterns & Gotchas

- **Mermaid is generated, never parsed:** the frontend renders the graph natively from the widget protocol (same JSON). `planToMermaid` exists for tool results / future mermaid.js rendering — the plan agent never writes mermaid text.
- **Total input handling:** untrusted JSON (the plan agent's output) never throws — parse failures surface as a deterministic `failed`/error, never a crash.
- **Progress machine is immutable + strict:** transitions return new snapshots and throw on violations; dispatch gating (`agentsToRun` → `startRunning` → `markDone` loop) terminates deterministically.
- **Artifacts per plan run:** `prd.md`, `clarify.md` (optional), `design.md`, `execution-plan.json` (main-agent-written) all live in `<run_dir>`.

## How to Update

- New execution mode → constrain it in `parseExecutionPlan` + update the PBT generators (`test/helpers/plan-gen.mts`).
- Shape change → update `parseExecutionPlan`, the PBT invariants (`plan-parse.test.mts`), and the mermaid/steps/progress derivations + their suites.
