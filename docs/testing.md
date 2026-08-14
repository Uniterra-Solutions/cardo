# Testing

## Current State

Automated test suites exist as **property-based tests (PBT)** in two lanes,
plus static gates at the repo root. No vitest/jest is used; PBT runs on
fast-check ^4.9 + node:test, driving compiled output:

| Lane                               | Command                                    | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cardo/jovaltus`                  | `pnpm --filter @cardo/jovaltus test:pbt`   | Extension ↔ pi-backend interaction: SQLite session store (model-based invariants), phase chains, prompt rendering, JSONL protocol, full tool surface vs a fake `pi` backend (`test/fixtures/fake-pi.mjs`)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@pi-gui/desktop` (vendored)       | `pnpm --filter @pi-gui/desktop test:pbt`   | Desktop frontend↔backend contract layer (app-store transitions, persistence, timeline) **+ renderer markdown regression** (`test/pbt/markdown-table.test.mts`, fast SSR, no browser). Timeline PBT covers reasoning streaming/collapse (`assistantThinkingDelta` → thinking item, finalize), tool-batch grouping (`timeline-turns.test.mts` — one request = one collapsible group, lone calls stay plain rows), and `pruneExpandState` invariants (value = current ∩ available; unchanged results return the identical `Set` reference so React bails out instead of re-rendering per streamed character) |
| `@pi-gui/pi-sdk-driver` (vendored) | `pnpm --filter @pi-gui/pi-sdk-driver test` | Vendored driver pure functions (incl. PBT)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

All suites are hermetic: no pi runtime, no LLM, no network, no real
agent-dir writes (the jovaltus suite redirects the agent dir per test via
`PI_CODING_AGENT_DIR`).

## Available Verification

### Static gates (repo root)

```bash
pnpm run typecheck    # tsc -b --noEmit
pnpm run lint         # eslint . (strictTypeChecked, max-warnings 0; vendor/, test/, scripts/ ignored)
pnpm run format:check # prettier --check .
pnpm run build        # tsc -b (jovaltus + runtime → dist) + copy jovaltus prompt assets into dist/prompts/
```

### Jovaltus PBT lane (`packages/jovaltus`)

```bash
pnpm --filter @cardo/jovaltus test:pbt
# = pnpm run build && tsc -p tsconfig.test.json && node --test "test/pbt/**/*.test.mts"
```

- Compiles + copies prompt assets into `dist/`, **type-checks the test files**
  (`tsconfig.test.json`, `allowImportingTsExtensions` + `noEmit`), then runs
  the suite against compiled `dist/` output (the desktop consumption path).
- Fixture backend: `test/fixtures/fake-pi.mjs` emulates `pi --mode json`
  (real child process; verdict-plan file drives deterministic fix loops).
  Stub `ExtensionAPI`/`ExtensionContext`: `test/helpers/stub-api.mts`.
- **Session-store invariants:** `state-machine.test.mts` runs a model-based
  property over arbitrary operation sequences (start / advance / verdict /
  finish / interrupt / resume / orphan-crash) — after every step the store
  must agree with a lock-step reference model and keep the global
  invariants (at most one running session owned by the current pid,
  ended_at iff not running, interrupted never records an error,
  newest-first listing, getPipeline == newest row).
- **Bug rule:** a property failing on a real source bug → fix source + add a
  deterministic regression test with the minimal counterexample. A failing
  property on a wrong test/generator → fix the test, never bend the source
  to an out-of-domain property.
- Run the suite 3+ times consecutively to surface seed-dependent failures.

### Desktop app gates (vendored)

```bash
pnpm --filter @pi-gui/desktop typecheck   # app + vendored driver packages (needs driver dist: run the 3 driver builds or pnpm --filter @pi-gui/desktop build first)
pnpm --filter @pi-gui/desktop build       # electron-vite production build (bundles main/preload/renderer)
pnpm --filter @pi-gui/desktop dev         # dev run — manual smoke
pnpm --filter @pi-gui/desktop test:pbt    # app-store contract PBT (compiles pure modules via tsconfig.pbt.json → out-pbt/)
pnpm --filter @pi-gui/pi-sdk-driver test  # vendored driver pure functions (incl. PBT)
```

#### Visual verification (design system)

Restyles land in token files (`styles/tokens.css`, `styles/base.css`) plus
per-surface CSS. Regression coverage is layered, fastest first:

1. **Fast SSR regression (default)** — `test/pbt/markdown-table.test.mts`
   renders `MessageMarkdown` with `react-dom/server` `renderToString` (no
   browser, no Electron; seconds) and asserts the GFM table wrapper +
   CSS contract (hairline border, sharp radius, `overflow-wrap: normal` on
   cells, header tint). This catches renderer/CSS regressions deterministically
   as part of `pnpm --filter @pi-gui/desktop test:pbt`.
2. **Hermetic Electron screenshot (opt-in, slow)** — for eyeball comparison
   only, when a restyle changes more than tokens can express. Launch via
   `electron.launch()` (plain `playwright`) with a temp `PI_APP_USER_DATA_DIR`
   - seeded agent dir and `PI_APP_TEST_MODE=background`, screenshot each page
     (threads / new-thread / settings / skills / extensions), and compare
     against the mockup.

Pitfalls: the app uses `requestSingleInstanceLock()` — kill leftover pi
Electron processes before each launch, or the new instance quits immediately
(`persistence flush timed out during quit` in stderr). See `docs/design-system.md`
for the token contract.

### Manual / ad-hoc verification (documented, hermetic)

Pure-logic paths can be verified without a pi runtime or LLM by loading the TS modules through pi's jiti and asserting behavior:

| Path                   | What to verify                                               | Method                                                                                    |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Extension registration | 6 tools + 3 events registered                                | Load `src/index.ts` via jiti with a stub `ExtensionAPI`; assert `registerTool`/`on` calls |
| Runtime registry       | `builtinExtensionFactories`/`builtinExtensionMetadata` shape | jiti-load `packages/runtime/src/index.ts`; assert factory array + metadata length/order   |

(State machine, prompt rendering, chain/verdict, and the child dispatch
contract are now covered automatically by the jovaltus PBT lane above.)

### End-to-end (requires pi login)

`plan` a small requirement in a `pi -e packages/jovaltus/src/index.ts` session; confirm artifacts + verdict flow. Requires a configured model provider. In the desktop app, the same flow runs with jovaltus as a built-in extension; verify provider login (Settings → Providers) and that phase child processes spawn correctly (they use `PI_CLI_PATH` + `ELECTRON_RUN_AS_NODE`).

## Test Conventions

- Any new automated tests must be hermetic: no pi runtime, no LLM, no network, no real agent-dir writes.
- Business logic lives in pure modules (`state.ts`, `chain.ts`, `prompts.ts`, dispatch JSONL helpers) so it can be property-tested against compiled output.
- Define the business rules as **invariants** (domain closure, persistence roundtrip, terminal locks, protocol contracts) and property-test the full flow with a fake backend, not just isolated helpers.
- Real bug found by a property → fix source + deterministic regression test pinning the minimal counterexample.

## How to Update

- New PBT suite → add a row to the lane table + run command.
- New verification path → add a row to the manual table.
- Source change that shifts module line numbers referenced in `docs/modules/*` → update those references.
