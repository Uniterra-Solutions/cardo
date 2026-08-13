# @cardo/jovaltus — Jovaltus pi-agent Extension

Subagent-driven development pipeline as a **pi-agent extension**: the same
four tools (`plan` → `execute` → `simplify` → `review`) and deterministic
phase chains from the [Jovaltus Hermes plugin](https://github.com/Uniterra-Solutions/jovaltus),
ported to run on pi's extension API.

## Tools

| Tool       | Arguments           | What it does                                                                                                                                     |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`     | `user_requirements` | PRD → research → acceptance → tasks chain, each phase an isolated subagent. Writes artifacts to `<cwd>/.plan/<date>/<name>/`.                    |
| `execute`  | `plan` (path)       | Drives the plan's task DAG level by level as an isolated subagent. Leaves changes **uncommitted** for simplify/review.                           |
| `simplify` | `plan` (optional)   | Reviewer finds simplification opportunities in the uncommitted diff; on `fix` the main agent applies them and the reviewer re-runs until `pass`. |
| `review`   | `plan` (optional)   | Adversarial review of the uncommitted diff (bugs, security, contract violations); same verdict-driven loop.                                      |

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
loaded extension; the four tools appear in the tool list.

> **Security:** extensions run with full system permissions. Only install
> from sources you trust.

## Architecture

| Hermes plugin concept                    | pi-agent equivalent                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `ctx.register_tool` × 4                  | `pi.registerTool()` × 4 (typebox schema)                                               |
| `subagent_lifecycle.launch()`            | child `pi --mode json -p --no-session --no-extensions` process (see `src/dispatch.ts`) |
| `state.py` PipelineState + JSON          | `src/state.ts` — persisted to `<agentDir>/jovaltus.json`                               |
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
- **State file** lives in pi's agent dir (`~/.pi/agent/jovaltus.json`),
  not Hermes's.
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
