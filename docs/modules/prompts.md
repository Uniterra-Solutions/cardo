# Module: prompts (`prompts.ts` + `prompts/`)

**Purpose:** Load and render the 5 phase goal documents dispatched to pipeline subagents (plus per-agent rendering for `execute_plan`).

Source: `packages/jovaltus/src/prompts.ts` (125 LOC) + `packages/jovaltus/src/prompts/*.md` (5 files). Rewritten from the Hermes plugin's 4-phase plan chain: prd/design write docs, the main agent produces the execution plan, and `execute-agent` runs the plan's agents.

## Public API

| Export              | Signature                                                  | Description                                                                                    |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PROMPT_NAMES`      | `readonly string[]`                                        | `prd, design, execute-agent, simplify-review, review`                                          |
| `loadPrompt`        | `(name: string) => string`                                 | Read raw markdown; throws on unknown name                                                      |
| `renderPrompt`      | `(p: PipelineState, phase: string, cwd: string) => string` | Load + `[[token]]` substitution + pipeline marker                                              |
| `renderAgentPrompt` | `(p, agentId, taskPrompt, cwd) => string`                  | `execute-agent.md` + `[[task_prompt]]` + auto-injected PRD/design (`readPlanContext`) + marker |
| `buildContext`      | `(p: PipelineState, cwd: string) => string`                | Context block: repo root / run dir / phase / plan path                                         |

## Prompt Files

| File                 | Phase       | Role                                                                                                                           |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `prd.md`             | plan/prd    | Product manager → writes `prd.md`                                                                                              |
| `design.md`          | plan/design | Architect → researches design + external libraries (minimize development complexity) → writes `design.md`                      |
| `execute-agent.md`   | execute     | One subagent per plan agent: `[[task_prompt]]` + auto-injected PRD/design context; completes its own task (no delegation tool) |
| `simplify-review.md` | simplify    | Simplification reviewer → writes `verdict.json`                                                                                |
| `review.md`          | review      | Adversarial reviewer → writes `verdict.json`                                                                                   |

(`prd`/`design`/`execute-agent` are plan-mode prompts; `simplify-review`/`review` serve the standalone verdict tools.)

## Token Substitution

| Token                            | Replaced with                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `[[run_dir]]`                    | pipeline run dir                                                                             |
| `[[repo_root]]`                  | session cwd                                                                                  |
| `[[user_requirements]]`          | plan input text                                                                              |
| `[[plan_path]]`                  | plan path (empty for plan-less runs)                                                         |
| `[[plan_step]]`                  | "read the plan" vs "review uncommitted changes standalone" (plan-less runs)                  |
| `[[task_prompt]]`                | one execute-plan agent's task_prompt (renderAgentPrompt only)                                |
| `[[plan_context]]`               | PRD + design doc + clarification, auto-injected (renderAgentPrompt only)                     |
| `[jovaltus-pipeline:TOOL:PHASE]` | literal marker with the actual tool/phase (execute: `[jovaltus-pipeline:execute:<agentId>]`) |

Substitution uses `String.replaceAll` with **function replacements** — never template literals (prompt bodies contain mermaid `{}` braces) and never string replacement values (they would interpret `$&`/`` $` ``/`$'`/`$n` from user-controlled fields and re-inject token text into the rendered prompt).

## Dependencies

- Inbound: `index.ts` (`renderPrompt`, `buildContext`).
- Outbound: `node:fs`, `node:path`, `node:url`, `type PipelineState` from `state.ts`.

## Patterns & Gotchas

- **Plan-mode prompts are new; verdict prompts are ported:** `prd`/`design`/`execute-agent` were written for the new plan-mode pipeline (the Hermes 4-phase chain is gone). `simplify-review`/`review` stay verbatim from the Hermes plugin except tool-name references.
- **Order matters:** `[[plan_step]]` is substituted BEFORE `[[plan_path]]` so the plan-step text's own embedded `[[plan_path]]` resolves too.
- **Dist consumers need the prompt files:** `loadPrompt` resolves prompts relative to the compiled module, so `pnpm run build` copies `src/prompts/*.md` → `dist/prompts/` (`scripts/copy-prompts.mjs`). A dist consumer (desktop app via `packages/runtime`) that cannot load a prompt fails on the very first phase dispatch — regression-locked by the PBT suite.
- **Marker is metadata only:** the `[jovaltus-pipeline:...]` line tells readers which phase produced an artifact; pi's tool handler tracks state itself. For execute agents the marker carries the agent id — tests use it for per-agent failure injection.

## How to Update

- New phase prompt → add file + `PROMPT_NAMES` + row in the prompt files table.
- Token added → update the substitution table + `renderPrompt`.
