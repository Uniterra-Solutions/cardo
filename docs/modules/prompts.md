# Module: prompts (`prompts.ts` + `prompts/`)

**Purpose:** Load and render the 7 phase goal documents dispatched to pipeline subagents.

Source: `packages/jovaltus/src/prompts.ts` (104 LOC) + `packages/jovaltus/src/prompts/*.md` (7 files). Ported from the Hermes plugin's `src/jovaltus/prompts/`; tool names adapted to pi (`read`/`grep`/`bash`).

## Public API

| Export         | Signature                                                  | Description                                                          |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `PROMPT_NAMES` | `readonly string[]`                                        | `prd, research, acceptance, tasks, execute, simplify-review, review` |
| `loadPrompt`   | `(name: string) => string`                                 | Read raw markdown; throws on unknown name                            |
| `renderPrompt` | `(p: PipelineState, phase: string, cwd: string) => string` | Load + `[[token]]` substitution + pipeline marker                    |
| `buildContext` | `(p: PipelineState, cwd: string) => string`                | Context block: repo root / run dir / phase / plan path               |

## Prompt Files

| File                 | Phase           | Role                                                                                      |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `prd.md`             | plan/prd        | Product manager → writes `prd.md`                                                         |
| `research.md`        | plan/research   | Architect → writes `design.md`                                                            |
| `acceptance.md`      | plan/acceptance | QA → writes `acceptance.md`                                                               |
| `tasks.md`           | plan/tasks      | Tech PM → writes `tasks.md` (task DAG)                                                    |
| `execute.md`         | execute         | Orchestrator → drives the DAG level by level (no delegation tool; completes tasks itself) |
| `simplify-review.md` | simplify        | Simplification reviewer → writes `verdict.json`                                           |
| `review.md`          | review          | Adversarial reviewer → writes `verdict.json`                                              |

## Token Substitution

| Token                            | Replaced with                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `[[run_dir]]`                    | pipeline run dir                                                                              |
| `[[repo_root]]`                  | session cwd                                                                                   |
| `[[user_requirements]]`          | plan input text                                                                               |
| `[[plan_path]]`                  | plan path (empty for plan-less runs)                                                          |
| `[[plan_step]]`                  | "read the plan" vs "review uncommitted changes standalone" (plan-less runs)                   |
| `[jovaltus-pipeline:TOOL:PHASE]` | literal marker with the actual tool/phase (retained for provenance; no functional role in pi) |

Substitution uses `String.replaceAll` — never template literals, because prompt bodies contain mermaid `{}` braces.

## Dependencies

- Inbound: `index.ts` (`renderPrompt`, `buildContext`).
- Outbound: `node:fs`, `node:path`, `node:url`, `type PipelineState` from `state.ts`.

## Patterns & Gotchas

- **Port fidelity:** prompts are verbatim from the Hermes plugin except tool-name references and the execute delegation section (pi children have no delegation tool).
- **Order matters:** `[[plan_step]]` is substituted BEFORE `[[plan_path]]` so the plan-step text's own embedded `[[plan_path]]` resolves too (`prompts.ts:88-94`).
- **Marker is metadata only:** the `[jovaltus-pipeline:...]` line tells readers which phase produced an artifact; pi's tool handler tracks state itself.

## How to Update

- New phase prompt → add file + `PROMPT_NAMES` + row in the prompt files table.
- Token added → update the substitution table + `renderPrompt`.
