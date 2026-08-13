# @cardo/jovaltus — Jovaltus pi-agent Extension

Subagent-driven development pipeline as a **pi-agent extension**: the same
four core tools (`plan` → `execute` → `simplify` → `review`) and
deterministic phase chains from the
[Jovaltus Hermes plugin](https://github.com/Uniterra-Solutions/jovaltus),
ported to run on pi's extension API — plus a persistent session store
(SQLite) with `list_sessions` and `resume_session`.

## Tools

| Tool             | Arguments           | What it does                                                                                                                                     |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`           | `user_requirements` | PRD → research → acceptance → tasks chain, each phase an isolated subagent. Writes artifacts to `<cwd>/.plan/<date>/<name>/`.                    |
| `execute`        | `plan` (path)       | Drives the plan's task DAG level by level as an isolated subagent. Leaves changes **uncommitted** for simplify/review.                           |
| `simplify`       | `plan` (optional)   | Reviewer finds simplification opportunities in the uncommitted diff; on `fix` the main agent applies them and the reviewer re-runs until `pass`. |
| `review`         | `plan` (optional)   | Adversarial review of the uncommitted diff (bugs, security, contract violations); same verdict-driven loop.                                      |
| `list_sessions`  | `status` (optional) | Lists every past pipeline session and its status (`running` / `done` / `failed` / `interrupted`), newest first.                                  |
| `resume_session` | `session_id`        | Resumes an `interrupted` or `failed` session (accepts the session id **or** its run directory).                                                  |

## Session persistence & resume

Every run is a **session row** in a SQLite store (`<agentDir>/jovaltus.sqlite`),
so the history survives restarts and is never overwritten by newer runs.

- **Interruption vs error:** a run that stops WITHOUT an error is recorded
  as `interrupted` (not `failed`): an aborted tool call, the session ending
  (`session_shutdown`), a newer run superseding it, or the owning process
  crashing (a `running` row owned by a dead pid is swept to `interrupted` on
  the next access). `failed` is reserved for real errors (phase subagent
  failure, missing verdict, ...).
- **Resume semantics:** a session parked in a fix round (`*_waiting`)
  resumes by falling back to the reviewer phase — the current diff is
  re-checked, then the fix loop continues. A session interrupted inside a
  phase re-runs that exact phase with a **resume note** appended to the
  prompt: the artifacts already on disk (prd.md, research.md, acceptance.md,
  tasks.md, the working tree) ARE the context, so the resumed subagent
  continues the in-progress work instead of restarting from scratch.
- `plan`/`execute`/`simplify`/`review` start a NEW session; resuming an old
  one keeps its id, run dir, and loop counter.

```text
# find the id of an interrupted run
list_sessions(status="interrupted")
# continue it from where it stopped
resume_session(session_id="<id>")
```

## Installation

Pi auto-discovers extensions from `~/.pi/agent/extensions/` (global),
`.pi/extensions/` (project-local), or installed pi packages.

```bash
# From this monorepo — one-off test (no install)
pi -e packages/jovaltus/src/index.ts

# Or install as a pi package (copies into the agent dir)
pi install ./packages/jovaltus

# Or manually
mkdir -p ~/.pi/agent/extensions
cp -r packages/jovaltus ~/.pi/agent/extensions/jovaltus
```

After install, `/reload` (or restart pi). The startup header lists the
loaded extension; the six tools appear in the tool list.

> **Security:** extensions run with full system permissions. Only install
> from sources you trust.

## Architecture

| Hermes plugin concept                    | pi-agent equivalent                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `ctx.register_tool` × 4                  | `pi.registerTool()` × 6 (plan/execute/simplify/review/list_sessions/resume_session)    |
| `subagent_lifecycle.launch()`            | child `pi --mode json -p --no-session --no-extensions` process (see `src/dispatch.ts`) |
| `state.py` PipelineState + JSON          | `src/state.ts` — SQLite session store at `<agentDir>/jovaltus.sqlite`                  |
| `CHAIN` table                            | `src/chain.ts`                                                                         |
| `subagent_start` / `subagent_stop` hooks | not needed — child processes are awaited inline                                        |
| `pre_llm_call` status injection          | `before_agent_start` event                                                             |
| `post_llm_call` reviewer re-dispatch     | `agent_settled` event                                                                  |
| completion / fix-request notifications   | `ctx.ui.notify()` / `pi.sendUserMessage()`                                             |
| `delegation.max_spawn_depth >= 2` check  | not needed — child processes have no depth limit                                       |

Key differences from the Hermes version:

- **No nested delegation**: phase subagents run with only the coding
  built-ins (`read, bash, edit, write, grep, find, ls`); the execute phase
  completes the task DAG itself instead of dispatching worker subagents
  (pi children have no delegation tool).
- **State store** lives in pi's agent dir (`~/.pi/agent/jovaltus.sqlite`),
  not Hermes's; every run is a session row (see "Session persistence &
  resume" above).
- **Default export**: pi's loader requires the entry factory to be a
  `default` export (`jiti.import(path, { default: true })` then
  `typeof factory === "function"`). `src/index.ts` is the single allowed
  default export in this package; every other module uses named exports
  (AGENTS.md).

## Development

```bash
pnpm --dir packages/jovaltus build      # or from root: pnpm run build
pnpm run typecheck                      # from repo root
pnpm run lint
pnpm run format:check
```

`package.json` declares `"pi": { "extensions": ["./src/index.ts"] }` so
`pi install ./packages/jovaltus` knows the entry point. pi loads the
TypeScript source directly via jiti — no build step is required to run the
extension, but the repo's typecheck/lint/build gates must stay green.

## Testing (integrated property-based tests)

```bash
pnpm --filter @cardo/jovaltus test:pbt
```

The PBT suite (`test/pbt/*.test.mts`, fast-check + node:test) defines the
pipeline's business logic as invariants and exercises the extension ↔ pi
backend interaction end-to-end:

- **Pure logic layers** — `state.ts` (domain closure of CHAIN-valid phase
  transitions, terminal lock, persistence roundtrip, corrupt-state
  recovery, and a **model-based property over arbitrary session-store
  operations** — start/supersede/finish/interrupt/resume/orphan-crash must
  preserve the invariants: at most one running session owned by the current
  pid, ended_at iff not running, interrupted never records an error,
  newest-first listing), `chain.ts` (edge validity, verdict-reader
  totality/roundtrip), `prompts.ts` (no leftover tokens, exact marker,
  `$`-pattern regression), `dispatch.ts` JSONL decoding (last assistant
  message_end wins, total over arbitrary output).
- **The real spawn path** — `runPhase` runs against
  `test/fixtures/fake-pi.mjs`, a `pi --mode json` backend stub: child args
  (`--no-extensions` recursion prevention, model/thinking forwarding,
  prompt temp file with 0600 mode, task last), exit codes, aborts, and the
  output/onText contract.
- **The full tool surface** — the factory's six tools plus the
  `before_agent_start` / `agent_settled` / `session_shutdown` hooks are
  driven through a stub `ExtensionAPI` against the fake backend:
  plan/execute/review trajectories, the verdict-driven fix loop (park → fix
  → re-dispatch → pass), a model-based property over random verdict plans,
  `list_sessions` history reporting, `resume_session` (interrupted review
  waiting / failed plan / failed execute), and abort/session-end →
  `interrupted` semantics.

Test isolation: the pi agent dir is redirected per test via
`PI_CODING_AGENT_DIR`, so the real `~/.pi/agent` is never touched. Tests
import the compiled `dist/` output (the desktop consumption path), which is
why the build copies `src/prompts/*.md` into `dist/prompts/` — a dist
consumer that cannot load a prompt fails on the very first phase dispatch
(regression-locked by `prompts.test.mts`).
