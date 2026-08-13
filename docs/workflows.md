# Workflows

Task recipes for agents working in this repo.

## Add a New Pipeline Tool

1. Add handler in `src/index.ts` (validate args → `startPipeline` → dispatch phases → finish).
2. Register with `pi.registerTool({ name, label, description, promptGuidelines, parameters: Type.Object(...), execute })`.
3. If the tool has phases: add chain edges to `src/chain.ts` `CHAIN` + `docs/modules/chain.md`.
4. If it uses a phase prompt: add `src/prompts/<name>.md` + `PROMPT_NAMES` + `docs/modules/prompts.md`.
5. If it needs state fields: extend `PipelineState` + `fromDict` + `docs/modules/state.md`.
6. Run `pnpm run typecheck && pnpm run lint && pnpm run format:check`.
7. Verify registration via the jiti stub (see `docs/testing.md`).

## Add a New Phase to an Existing Chain

1. Create `src/prompts/<phase>.md` (copy a sibling's structure; keep `[[token]]` placeholders + the pipeline marker).
2. Add to `PROMPT_NAMES` + `PHASE_PROMPTS` in `src/prompts.ts`.
3. Wire the edge in `src/chain.ts` `CHAIN` (and the waiting/re-dispatch loop if it is a reviewer phase).
4. Update `docs/modules/chain.md` + `docs/modules/prompts.md` tables.

## Run a Plan Pipeline End-to-End

1. `pi -e packages/jovaltus/src/index.ts` (or install the package).
2. In the session: `plan` with `user_requirements`.
3. Watch `.plan/<date>/<name>/` fill with `prd.md` → `design.md` → `acceptance.md` → `tasks.md`.
4. `execute` with the `tasks.md` path (after user approval).
5. `review` / `simplify` on the uncommitted diff; on `fix` the main agent applies findings and the reviewer re-runs until `pass`.

## Debug a Failed Phase

1. Check `~/.pi/agent/jovaltus.json` → pipeline `status`/`error`.
2. Run the child invocation manually with the same flags (see `docs/modules/dispatch.md`) to see the raw error.
3. Verify pi auth: `pi --list-models` must not print "No models available".
4. Confirm the run dir exists and `verdict.json` (review phases) was written.

## Port a Change from the Hermes Plugin

1. Locate the source in `Uniterra-Solutions/jovaltus` (`src/jovaltus/{tools,hooks,state}.py`, `prompts/*.md`).
2. Map APIs: `subagent_lifecycle` → child process (`dispatch.ts`); `pre_llm_call` → `before_agent_start`; `post_llm_call` → `agent_settled`; completion queue → `ctx.ui.notify` + `pi.sendUserMessage`.
3. Keep prompts verbatim except tool names (`read_file`→`read`, `search_files`→`grep`, `terminal`→`bash`) and delegation references (pi children have no delegation tool).
4. Preserve the `[jovaltus-pipeline:TOOL:PHASE]` marker as provenance metadata.

## How to Update

- New common task → add a recipe following the numbered-step format.
- Changed pipeline semantics → update the affected recipes (especially "Run a Plan Pipeline").
