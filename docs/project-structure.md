# Project Structure

| Directory / File                 | Responsibility                               | Key Files                                                                                                                                                          |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/general/`              | App-wide working-rules extension             | `src/index.ts` (factory + `before_agent_start` append)                                                                                                             |
| `packages/jovaltus/src/`         | Jovaltus pipeline extension (all logic)      | `index.ts`, `state.ts`, `chain.ts`, `dispatch.ts`, `prompts.ts`, `plan.ts`, `plan-json.ts`, `plan-mermaid.ts`, `plan-progress.ts`, `plan-steps.ts`, `plan-mode.ts` |
| `packages/jovaltus/src/prompts/` | Phase goal documents for pipeline subagents  | `prd.md`, `design.md`, `execute-agent.md`, `simplify-review.md`, `review.md`                                                                                       |
| `packages/jovaltus/`             | Package manifest + pi entry declaration      | `package.json` (`"pi": {"extensions": ["./src/index.ts"]}`; `exports` → `dist`)                                                                                    |
| `packages/general/`              | Package manifest + pi entry declaration      | `package.json` (`"pi": {"extensions": ["./src/index.ts"]}`; `exports` → `dist`)                                                                                    |
| `packages/runtime/`              | Desktop runtime: built-in extension registry | `src/index.ts` (`builtinExtensionFactories`, `builtinExtensionMetadata`)                                                                                           |
| `vendor/pi-gui/`                 | Vendored desktop app (git subtree)           | `apps/desktop/` (Electron shell), `packages/pi-sdk-driver/`, `packages/session-driver/`, `packages/catalogs/`                                                      |
| Root (`.`)                       | Shared tooling + workspace wiring only       | `package.json`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.husky/`, `pnpm-workspace.yaml`                                        |
| `docs/`                          | Project documentation (this tree)            | `README.md` hub, `architecture.md`, `modules/*.md`                                                                                                                 |

## Module map (`packages/jovaltus/src/`)

| Module             | LOC | Public API                                                                                                                                                                                        |
| ------------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | 927 | `default` factory (entry) — registers 6 tools + 5 events; `runPlanPipeline`, `runPlanExecution`, `execute_plan` handler                                                                           |
| `state.ts`         | 584 | `PipelineState`, `PHASES`, `STATUSES`, `getPipeline`, `startPipeline`, `setPhase`, `setVerdict`, `finishPipeline`, `markInterrupted`, `listSessions`, `getSession`, `resumeSession`, `statusText` |
| `dispatch.ts`      | 211 | `PhaseResult`, `runPhase`                                                                                                                                                                         |
| `chain.ts`         | 87  | `CHAIN`, `WAITING_PHASES`, `waitingPhase`, `readVerdict`, `readFindings`                                                                                                                          |
| `prompts.ts`       | 125 | `PROMPT_NAMES`, `loadPrompt`, `renderPrompt`, `renderAgentPrompt`, `buildContext`                                                                                                                 |
| `plan.ts`          | 97  | `ExecutionPlan`, `parseExecutionPlan`                                                                                                                                                             |
| `plan-json.ts`     | 56  | `readExecutionPlan`, `readRunDoc`, `readPlanContext`                                                                                                                                              |
| `plan-mermaid.ts`  | 60  | `planToMermaid`                                                                                                                                                                                   |
| `plan-progress.ts` | 92  | `PlanProgress`, `createProgress`, `agentsToRun`, `startRunning`, `markDone`, `isComplete`                                                                                                         |
| `plan-steps.ts`    | 23  | `deriveExecutionSteps`                                                                                                                                                                            |
| `plan-mode.ts`     | 221 | `registerPlanMode`, `PLAN_MODE_TOOLS`, widget protocol helpers                                                                                                                                    |

## Module map (`packages/general/src/`)

| Module     | Public API                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `index.ts` | `default` factory (entry) — registers `before_agent_start` to append `WORKING_RULES` (8 rules) |

## Module map (`packages/runtime/src/`)

| Module     | Public API                                              |
| ---------- | ------------------------------------------------------- |
| `index.ts` | `builtinExtensionFactories`, `builtinExtensionMetadata` |

## Vendored desktop app (`vendor/pi-gui`)

- `apps/desktop/` — Electron app: `electron/main.ts` (cardo integration seam: `extensionFactories` + `inlineExtensionMetadata` spreads, `PI_CLI_PATH` bootstrap), `electron/app-store.ts` (async `create`), React renderer.
- `packages/pi-sdk-driver/` — adapter over `@earendil-works/pi-coding-agent` (ported to pi 0.84.1 `ModelRuntime`).
- Cardo patches inside `vendor/` are minimal and marked with `// Cardo:` comments; everything else is upstream-managed via `git subtree pull`.

## How to Update

- New source module → add row to module map, create `docs/modules/<name>.md`, index it in `docs/README.md`.
- Directory added/removed/repurposed → update the directory table.
