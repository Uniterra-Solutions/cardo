# Testing

## Current State

No test framework is installed (no vitest/jest; not in `package.json`). The repo gates are static only: `typecheck`, `lint`, `format:check`, `build`. There is no automated test suite yet. The vendored desktop app carries its own Playwright E2E suite inside `vendor/pi-gui` (not wired into cardo's root gates).

## Available Verification

### Static gates (repo root)

```bash
pnpm run typecheck    # tsc -b --noEmit
pnpm run lint         # eslint . (strictTypeChecked, max-warnings 0; vendor/ ignored)
pnpm run format:check # prettier --check . (vendor/ ignored)
pnpm run build        # tsc -b (jovaltus + runtime → dist)
```

### Desktop app gates

```bash
pnpm --filter @pi-gui/desktop typecheck   # app + vendored driver packages (needs driver dist: run the 3 driver builds or pnpm --filter @pi-gui/desktop build first)
pnpm --filter @pi-gui/desktop build       # electron-vite production build (bundles main/preload/renderer)
pnpm --filter @pi-gui/desktop dev         # dev run — manual smoke
```

### Manual / ad-hoc verification (documented, hermetic)

Pure-logic paths can be verified without a pi runtime or LLM by loading the TS modules through pi's jiti and asserting behavior:

| Path                   | What to verify                                                          | Method                                                                                    |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Extension registration | 4 tools + 2 events registered                                           | Load `src/index.ts` via jiti with a stub `ExtensionAPI`; assert `registerTool`/`on` calls |
| Prompt rendering       | `[[token]]` substitution, marker replacement, unknown-prompt throw      | Call `renderPrompt`/`loadPrompt` directly                                                 |
| State machine          | start/resume/phase/verdict/finish/reset                                 | Call state functions; check disk persistence + `getPipeline` resume                       |
| Chain/verdict          | CHAIN edges, `readVerdict`/`readFindings` against a temp `verdict.json` | Write temp verdict file, assert readers                                                   |
| Runtime registry       | `builtinExtensionFactories`/`builtinExtensionMetadata` shape            | jiti-load `packages/runtime/src/index.ts`; assert factory array + metadata length/order   |

**Hermetic rule:** never point state tests at the real `~/.pi/agent/jovaltus.json` (repo paths leak); use a temp dir or reset state after.

### End-to-end (requires pi login)

`plan` a small requirement in a `pi -e packages/jovaltus/src/index.ts` session; confirm artifacts + verdict flow. Requires a configured model provider. In the desktop app, the same flow runs with jovaltus as a built-in extension; verify provider login (Settings → Providers) and that phase child processes spawn correctly (they use `PI_CLI_PATH` + `ELECTRON_RUN_AS_NODE`).

## Test Conventions

- Any new automated tests must be hermetic: no pi runtime, no LLM, no network, no real agent-dir writes.
- Unit-test the state machine against a temp/overridable state path.
- When a test framework is added, update this file's "Current State" + commands.

## How to Update

- Test framework added → replace Current State + add the run commands.
- New verification path → add a row to the manual table.
