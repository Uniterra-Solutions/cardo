# Project Structure

| Directory / File                 | Responsibility                              | Key Files                                                                                                                   |
| -------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/jovaltus/src/`         | Jovaltus pipeline extension (all logic)     | `index.ts`, `state.ts`, `chain.ts`, `dispatch.ts`, `prompts.ts`                                                             |
| `packages/jovaltus/src/prompts/` | Phase goal documents for pipeline subagents | `prd.md`, `research.md`, `acceptance.md`, `tasks.md`, `execute.md`, `simplify-review.md`, `review.md`                       |
| `packages/jovaltus/`             | Package manifest + pi entry declaration     | `package.json` (`"pi": {"extensions": ["./src/index.ts"]}`)                                                                 |
| Root (`.`)                       | Shared tooling + workspace wiring only      | `package.json`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.husky/`, `pnpm-workspace.yaml` |
| `docs/`                          | Project documentation (this tree)           | `README.md` hub, `architecture.md`, `modules/*.md`                                                                          |

## Module map (`packages/jovaltus/src/`)

| Module        | LOC | Public API                                                                                                                                       |
| ------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`    | 439 | `default` factory (entry) — registers 4 tools + 2 events                                                                                         |
| `state.ts`    | 255 | `PipelineState`, `PHASES`, `STATUSES`, `getPipeline`, `startPipeline`, `setPhase`, `setVerdict`, `finishPipeline`, `statusText`, `resetPipeline` |
| `dispatch.ts` | 211 | `PhaseResult`, `runPhase`                                                                                                                        |
| `chain.ts`    | 85  | `CHAIN`, `WAITING_PHASES`, `waitingPhase`, `readVerdict`, `readFindings`                                                                         |
| `prompts.ts`  | 104 | `PROMPT_NAMES`, `loadPrompt`, `renderPrompt`, `buildContext`                                                                                     |

## How to Update

- New source module → add row to module map, create `docs/modules/<name>.md`, index it in `docs/README.md`.
- Directory added/removed/repurposed → update the directory table.
