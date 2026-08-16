# Testing

## Current State

Automated test suites exist as **property-based tests (PBT)** in two lanes plus a
Playwright e2e lane against the Electron app, and static gates at the repo root.
No vitest/jest is used; PBT runs on fast-check ^4.9 + node:test, driving
compiled output:

| Lane                               | Command                                                                                                                            | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cardo/jovaltus`                  | `pnpm --filter @cardo/jovaltus test:pbt`                                                                                           | Extension ↔ pi-backend interaction: SQLite session store (model-based invariants), phase chains, prompt rendering, JSONL protocol, plan-mode tool gating + execute-widget protocol, and the full tool surface vs a fake `pi` backend (`test/fixtures/fake-pi.mjs`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@pi-gui/desktop` (vendored)       | `pnpm --filter @pi-gui/desktop test:pbt`                                                                                           | Desktop frontend↔backend contract layer (app-store transitions, persistence, timeline) **+ renderer markdown regression** (`test/pbt/markdown-table.test.mts`, fast SSR, no browser). Timeline PBT covers reasoning streaming/collapse (`assistantThinkingDelta` → thinking item, finalize), tool-batch grouping (`timeline-turns.test.mts` — one request = one collapsible group, lone calls stay plain rows), and `pruneExpandState` invariants (value = current ∩ available; unchanged results return the identical `Set` reference so React bails out instead of re-rendering per streamed character). Streaming-sync PBT (`test/pbt/streaming-sync.test.mts`) locks the streaming delivery contract by mirroring the real per-event pipeline (`appendAssistantDelta`/`applyTimelineEvent`/`applySessionEventState`) plus the pure coalescing decision logic (`decideStreamPublish` from `electron/stream-publish.ts`): **content accounting** (Σ delta text == Σ transcript text — no lost/duplicated deltas), **item-identity stability** (ids/kinds never change, text only grows), **payload monotonicity** (each renderer snapshot extends the previous one), and **liveness** (coalesced window pushes: ≤ 1 per `STREAM_PUBLISH_INTERVAL_MS`, trailing edge always carries the latest state, push count bounded by wall-clock windows not event count — the fix for the frontend-falls-behind-backend symptom on long tasks). Store-liveness invariants (`test/pbt/store-liveness.test.mts`): **K** — the session-state fold (`applySessionEventState`) never performs a full-array copy pass over the accumulated transcript (behavioral Proxy detector); **K′** — the FULL fold path's rebuild work is linear in event count (persistent `TranscriptCacheEntry` — chunked immutable chunks, O(1) id index, parts-list streaming — replaced the per-event `[...transcript]` rebuilds; 3000 events ≈ 3.4 µs/event, per-event cost no longer grows with transcript length); **J** — content-unchanged transcript items keep object identity (the delta-diff/memo `===` contract). `test/pbt/transcript-store.test.mts` pins the entry semantics; `test/pbt/state-delta.test.mts` locks the STATE snapshot+delta channel (`src/state-delta.ts`): byte-compatible convergence vs the full-snapshot path, untouched-slice identity, delivery decisions (full on first/switch/recovery, zero ops when unchanged), `orchestrationChildren` exclusion (own `pi-gui:orchestration-changed` channel), revision handling. Update-check PBT (`test/pbt/cardo-update-logic.test.mts`) covers semver comparison (parseable + garbage inputs, prerelease precedence) and the resolve/skip logic (update iff release or CLI is newer; latest = max of the two; skip suppresses prompts until a newer version appears) |
| `@uniterra-solutions/cardo` (CLI)  | `pnpm --filter @uniterra-solutions/cardo test`                                                                                     | CLI unit tests (node:test on compiled `dist/`): `stop-app.test.mts` drives the injected process-ops stop sequence with a fake ops object (AppleScript quit first, poll until exit, SIGKILL stragglers, no stop on `--dry-run`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@pi-gui/pi-sdk-driver` (vendored) | `pnpm --filter @pi-gui/pi-sdk-driver test`                                                                                         | Vendored driver pure functions (incl. PBT)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@pi-gui/desktop` e2e (cardo)      | `pnpm --filter @pi-gui/desktop run test:cardo:core:multi-window` / `test:cardo:core:mentions-diff` / `test:cardo:core:update-flow` | Playwright e2e against the real Electron app (cardo-runnable since `@playwright/test` is a desktop devDep; the vendored root's copy is never installed by the cardo workspace). Covers shortcut remapping (Cmd+N → new thread under the selected workspace, Cmd+Shift+N → new window, Cmd+Alt+J → files panel), File menu accelerators, mention menu, the diff/files panels, and the update-check dialog flow (local fixture server + stubbed `dialog.showMessageBox`: Update Now spawns the fake updater and quits the app, Skip persists the version and suppresses the next prompt, Later persists nothing and re-prompts, up-to-date shows no prompt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

All PBT suites are hermetic: no pi runtime, no LLM, no network, no real
agent-dir writes (the jovaltus suite redirects the agent dir per test via
`PI_CODING_AGENT_DIR`). The desktop e2e lane is the exception: it launches
the real Electron app with a fake provider key and `PI_OFFLINE=1` (forced in
`buildDesktopLaunchEnv` unless `realAuthSourceDir` opts out — pi's
model-availability refresh otherwise waits on real network calls that hang in
restricted environments and never contribute real auth anyway).

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
- **Plan-mode invariants:** `plan-*.test.mts` lock the execution-plan
  contract — the total parser rejects every shape violation and normalizes
  valid plans (`plan-parse`), steps = batch-major id sets (`plan-steps`),
  mermaid output structure + hostile-prompt escaping (`plan-mermaid`),
  the strict immutable progress machine with batch gating (`plan-progress`),
  and the mode layer: toggle/gate/persistence/session-start restore plus the
  execute-widget line protocol (including a fast-check property that no value
  contains `|`) and integrated `execute_plan` streaming (`plan-mode`).
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
pnpm --filter @pi-gui/desktop run test:cardo:core:multi-window   # e2e: multi-window + shortcut remapping
pnpm --filter @pi-gui/desktop run test:cardo:core:mentions-diff  # e2e: mention menu + diff/files panels (Cmd+D / Cmd+Alt+J)
pnpm --filter @pi-gui/desktop run test:cardo:core:update-flow  # e2e: update-check dialog flow (fixture server + stubbed dialog)
pnpm --filter @pi-gui/pi-sdk-driver test  # vendored driver pure functions (incl. PBT)
```

### CLI lane (`packages/cli`)

```bash
pnpm --filter @uniterra-solutions/cardo test
# = pnpm run build && tsc -p tsconfig.test.json && node --test test/**/*.test.mts
```

- Compiles the CLI to `dist/`, type-checks the test files, then runs the suite against compiled output.
- `stop-app.test.mts` injects a fake `ProcessOps` object so the stop sequence (AppleScript quit → poll for exit → SIGKILL) is verified without touching real processes.
- **Bug rule:** a property failing on a real source bug → fix source + a deterministic regression test with the minimal counterexample. A failing property on a wrong test/generator → fix the test, never bend the source to an out-of-domain property.
- Run the suite 3+ times consecutively to surface seed-dependent failures.

#### Desktop e2e notes

- Runs need built `out/` + `dist/` (the scripts run `pnpm build` first; driver `dist/` comes from `pnpm run build` at the repo root or the driver builds).
- The harness forces `PI_APP_DISABLE_CARDO_UPDATE_CHECK=1` in `buildDesktopLaunchEnv` so no spec ever probes npm/GitHub; `test:cardo:core:update-flow` opts out by deleting the key via `envOverrides` and feeds a local fixture server (`CARDO_UPDATE_API_BASE` / `CARDO_UPDATE_NPM_URL`) with a fake updater command (`CARDO_UPDATE_COMMAND`) and a stubbed `dialog.showMessageBox`.
- The app uses `requestSingleInstanceLock()` — kill leftover pi Electron processes before each run. From-source runs (dev server / `electron .` / preview) now use the `pi-dev` user-data dir, so they no longer share the lock with a running packaged app — but two dev instances still clash on the `pi-dev` lock (see the visual-verification pitfall below).
- Windows/Linux: Cmd+N / Cmd+Shift+N rely on `before-input-event`; the macOS File menu bindings are asserted platform-gated (`test.skip` inside the test body).
- Extension-UI behavior specs live in `tests/live/`: `extension-dock.spec.ts` (single collapsed dock inside the composer surface, literal fallback summaries, no transcript spam from widget ticks), `extension-dock-reload.spec.ts` (dock collapses on /reload and extension refresh — locked by the per-session extension-UI `revision`), `jovaltus-mode-toggle.spec.ts` (plan-mode toggle runs silently: no timeline message, no dock bar), `jovaltus-new-thread-mode.spec.ts` (new-thread page's standard/plan picker starts the conversation in plan mode; /planmode runs silently before the first message). The `tests/core/*` lane holds the layout/visual contracts.

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
3. **Composer layout regression (e2e)** — `tests/core/composer-layout.spec.ts`
   asserts the single-row composer geometry (attach | textarea | selectors |
   send all on one line inside the surface, textarea vertically centered with
   the send button, environment select present on new-thread), the 1px surface
   border without the `0 0 0 1px` focus-ring shadow layer, and the global
   scrollbar CSS contract (7px width, transparent track, `--muted`-alpha thumb,
   `scrollbar-width: thin`) via computed styles — hermetic, no screenshots.
4. **Titlebar strip geometry (e2e)** — `tests/core/sidebar-toggle.spec.ts`
   asserts the sidebar toggle is flush at the window's top-left corner (≤20px),
   the New thread button starts below the 48px titlebar strip (≥44px, so it
   clears the macOS traffic lights and the corner toggle in every window mode),
   and the collapsed-mode clearances (`toggleRight <= topbarLeft`) keep the
   main column out of the traffic-light zone.

Pitfalls: the app uses `requestSingleInstanceLock()` — kill leftover pi
Electron processes before each launch, or the new instance quits immediately
(`persistence flush timed out during quit` in stderr). From-source runs use the
`pi-dev` user-data dir (`electron/main.ts`, `// Cardo:` patch), so a leftover
dev instance no longer white-screens the packaged app — but the packaged app's
`pi` dir and dev's `pi-dev` dir each still lock against themselves. See
`docs/design-system.md` for the token contract.

### Manual / ad-hoc verification (documented, hermetic)

Pure-logic paths can be verified without a pi runtime or LLM by loading the TS modules through pi's jiti and asserting behavior:

| Path                   | What to verify                                               | Method                                                                                    |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Extension registration | 6 tools + 5 events registered                                | Load `src/index.ts` via jiti with a stub `ExtensionAPI`; assert `registerTool`/`on` calls |
| Runtime registry       | `builtinExtensionFactories`/`builtinExtensionMetadata` shape | jiti-load `packages/runtime/src/index.ts`; assert factory array + metadata length/order   |

(State machine, prompt rendering, chain/verdict, and the child dispatch
contract are now covered automatically by the jovaltus PBT lane above.)

### End-to-end (requires pi login)

Toggle plan mode on (`/planmode`; TUI shift+P; desktop shift+tab / mode button), `plan` a small requirement in a `pi -e packages/jovaltus/src/index.ts` session, let the main agent write failing PBTs + `execution-plan.json`, then `execute_plan <plan_id>`; confirm artifacts + dispatch + verdict flow. Requires a configured model provider. In the desktop app, the same flow runs with jovaltus as a built-in extension; verify provider login (Settings → Providers) and that phase child processes spawn correctly (they use `PI_CLI_PATH` + `ELECTRON_RUN_AS_NODE`).

## Test Conventions

- Any new automated tests must be hermetic: no pi runtime, no LLM, no network, no real agent-dir writes. **Exception:** the desktop e2e lane (`test:cardo:core:*`) launches the real Electron app offline with a fake provider key.
- Business logic lives in pure modules (`state.ts`, `chain.ts`, `prompts.ts`, dispatch JSONL helpers) so it can be property-tested against compiled output.
- Define the business rules as **invariants** (domain closure, persistence roundtrip, terminal locks, protocol contracts) and property-test the full flow with a fake backend, not just isolated helpers.
- Real bug found by a property → fix source + deterministic regression test pinning the minimal counterexample.

## How to Update

- New PBT suite → add a row to the lane table + run command.
- New verification path → add a row to the manual table.
- Source change that shifts module line numbers referenced in `docs/modules/*` → update those references.
