# Workflows

Task recipes for agents working in this repo.

## Add a New Pipeline Tool

1. Add handler in `src/index.ts` (validate args → `startPipeline` → dispatch phases → finish).
2. Register with `pi.registerTool({ name, label, description, promptGuidelines, parameters: Type.Object(...), execute })`.
3. If the tool has phases: add chain edges to `src/chain.ts` `CHAIN` + `docs/modules/chain.md`.
4. If it uses a phase prompt: add `src/prompts/<name>.md` + `PROMPT_NAMES` + `docs/modules/prompts.md`.
5. If it needs state fields: extend `PipelineState` + `SessionRow` + `rowToPipeline` + `insertRow`/`persistLive` + `docs/modules/state.md`.
6. If it changes session lifecycle semantics (supersede / interrupt / resume): update the model-based property in `test/pbt/state-machine.test.mts` and add a deterministic regression for the new edge.
7. Run `pnpm run typecheck && pnpm run lint && pnpm run format:check`.
8. Run the jovaltus PBT suite (`pnpm --filter @cardo/jovaltus test:pbt`) — it encodes invariants over the state machine / chains / prompts / dispatch and fails on drift (e.g. a tool whose first phase no longer matches `CHAIN`, or a prompt with an unsubstituted token). A failing property on a real bug → fix source + add a deterministic regression test.
9. Verify registration via the jiti stub (see `docs/testing.md`).

## Add a New Phase to an Existing Chain

1. Create `src/prompts/<phase>.md` (copy a sibling's structure; keep `[[token]]` placeholders + the pipeline marker).
2. Add to `PROMPT_NAMES` + `PHASE_PROMPTS` in `src/prompts.ts`.
3. Wire the edge in `src/chain.ts` `CHAIN` (and the waiting/re-dispatch loop if it is a reviewer phase).
4. Update `docs/modules/chain.md` + `docs/modules/prompts.md` tables.
5. Run `pnpm --filter @cardo/jovaltus test:pbt` — the prompt/marker/chain invariants lock the new phase; waiting phases must NOT get a prompt file (they are never dispatched).

## Run a Plan Pipeline End-to-End

1. `pi -e packages/jovaltus/src/index.ts` (or install the package).
2. In the session: `plan` with `user_requirements`.
3. Watch `.plan/<date>/<name>/` fill with `prd.md` → `design.md` → `acceptance.md` → `tasks.md`.
4. `execute` with the `tasks.md` path (after user approval).
5. `review` / `simplify` on the uncommitted diff; on `fix` the main agent applies findings and the reviewer re-runs until `pass`.

## Debug a Failed Phase

1. Check `list_sessions` (or `~/.pi/agent/jovaltus.sqlite`) for the run's `status`/`error`. An `interrupted` run (abort/session-end/crash) can be continued with `resume_session`; a `failed` run records the error.
2. Run the child invocation manually with the same flags (see `docs/modules/dispatch.md`) to see the raw error.
3. Verify pi auth: `pi --list-models` must not print "No models available".
4. Confirm the run dir exists and `verdict.json` (review phases) was written.

## Resume an Interrupted Pipeline

1. `list_sessions(status="interrupted")` (or filter `failed`) to find the
   session — note its `id` or `run_dir`.
2. `resume_session(session_id="<id>")` — accepts the id or the run
   directory. A session parked in a fix round (`review_waiting` /
   `simplify_waiting`) falls back to the reviewer phase and re-checks the
   current diff; any other session re-runs its interrupted phase with a
   resume note (reuse artifacts, continue the working tree).
3. A `failed` session is resumable too (it re-attempts from its phase); a
   `running` or `done` session is refused — finish or list first.
4. Interrupted sessions are also auto-recovered: a `running` row left by a
   crashed process is swept to `interrupted` on the next store access, so a
   direct resume after a crash works without any manual cleanup.

## Port a Change from the Hermes Plugin

1. Locate the source in `Uniterra-Solutions/jovaltus` (`src/jovaltus/{tools,hooks,state}.py`, `prompts/*.md`).
2. Map APIs: `subagent_lifecycle` → child process (`dispatch.ts`); `pre_llm_call` → `before_agent_start`; `post_llm_call` → `agent_settled`; completion queue → `ctx.ui.notify` + `pi.sendUserMessage`.
3. Keep prompts verbatim except tool names (`read_file`→`read`, `search_files`→`grep`, `terminal`→`bash`) and delegation references (pi children have no delegation tool).
4. Preserve the `[jovaltus-pipeline:TOOL:PHASE]` marker as provenance metadata.

## How to Update

- New common task → add a recipe following the numbered-step format.
- Changed pipeline semantics → update the affected recipes (especially "Run a Plan Pipeline").
