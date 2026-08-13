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

## Testing (integrated property-based tests)

```bash
pnpm --filter @cardo/jovaltus test:pbt
```

The PBT suite (`test/pbt/*.test.mts`, fast-check + node:test) defines the
pipeline's business logic as invariants and exercises the extension ↔ pi
backend interaction end-to-end:

- **Pure logic layers** — `state.ts` (domain closure of CHAIN-valid phase
  transitions, terminal lock, persistence roundtrip, corrupt-state
  recovery), `chain.ts` (edge validity, verdict-reader totality/roundtrip),
  `prompts.ts` (no leftover tokens, exact marker, `$`-pattern regression),
  `dispatch.ts` JSONL decoding (last assistant message_end wins, total over
  arbitrary output).
- **The real spawn path** — `runPhase` runs against
  `test/fixtures/fake-pi.mjs`, a `pi --mode json` backend stub: child args
  (`--no-extensions` recursion prevention, model/thinking forwarding,
  prompt temp file with 0600 mode, task last), exit codes, aborts, and the
  output/onText contract.
- **The full tool surface** — the factory's four tools plus the
  `before_agent_start` / `agent_settled` hooks are driven through a stub
  `ExtensionAPI` against the fake backend: plan/execute/review trajectories,
  the verdict-driven fix loop (park → fix → re-dispatch → pass), and a
  model-based property over random verdict plans.

Test isolation: the pi agent dir is redirected per test via
`PI_CODING_AGENT_DIR`, so the real `~/.pi/agent` is never touched. Tests
import the compiled `dist/` output (the desktop consumption path), which is
why the build copies `src/prompts/*.md` into `dist/prompts/` — a dist
consumer that cannot load a prompt fails on the very first phase dispatch
(regression-locked by `prompts.test.mts`).
