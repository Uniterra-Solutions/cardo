# Testing

Runner: node:test (Node 22 built-in). Property-based tests: fast-check 4. No root test script — each package owns its lane. Every package builds first, then tests the compiled output (`dist/` or `lib/`). ESLint ignores `**/test/` and `**/scripts/`; test files are type-checked by each package's `tsc -p tsconfig.test.json` inside the test lane.

## Commands

| Package            | Command                                        | Covers                                                                                                                                                        |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cardo-desktop      | `pnpm --filter @cardo/cardo-desktop test`      | profile-bootstrap unit tests + built-ins/readiness PBT                                                                                                        |
| cardo-provider     | `pnpm --filter @cardo/cardo-provider test`     | composition + dual-protocol translate + reasoning-preservation regressions + seeded properties                                                                |
| cardo-cli          | `pnpm --filter @uniterra-solutions/cardo test` | CLI unit tests + install-logic PBT                                                                                                                            |
| cardo-updater      | `pnpm --filter @cardo/cardo-updater test`      | decision semantics (fast-check)                                                                                                                               |
| cardo-skills       | `pnpm --filter @cardo/cardo-skills test`       | provisioning tests (every skill ships SKILL.md; idempotent)                                                                                                   |
| cardo-systemprompt | `pnpm --filter @cardo/cardo-systemprompt test` | rule injection: registration, append, no cross-turn duplication                                                                                               |
| container          | `scripts/verify-cli-container/run.sh`          | clean-container installer replay + provisioning PBT + real dsh boot                                                                                           |
| windows-install    | `scripts/verify-windows-install/verify.ps1`    | real `cardo setup --source` on windows-latest: package → embed → install → shortcut → `Cardo.exe` boot smoke (runs in the release gate, not locally on macOS) |

Static gates: `pnpm run typecheck` (`tsc -b --noEmit`), `pnpm run lint` (`eslint .`, max-warnings 0), `pnpm format:check`. Pre-commit hook runs `lint-staged` with `--max-warnings 0`.

## PBT Invariants (the safety net)

| Suite                                                          | Invariants                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cardo-desktop/test/builtin-pbt.test.mjs`             | `hasAllBuiltins` true iff every expected bundle present (order/extras irrelevant, malformed → false); vendored/workspace staleness by version identity; readiness URL parse across chunk-boundary splits (port-completeness regex); `dsh plugin add` + boot to a reachable URL                                                                                                                                                                                |
| `packages/cardo-cli/test/pbt.test.mts`                         | `parseArgs` semantics (`--no-open`/`--dry-run` commute, `--source` consumes the next token, `--version` wins, first positional = command); `installPlan` stage order (`update` = CLI refresh → rebuild → relaunch, `setup` never touches the CLI, dry-run runs nothing, relaunch iff `open`); `.app` discovery over all `mac-*` shapes; `win-unpacked` discovery; install destinations / builder args / launch targets / shortcut script quoting per platform |
| `packages/cardo-provider/test/reasoning-preservation.test.mjs` | No loss / no duplication of reasoning, text, and tool calls across every gateway wire shape — per-shape regressions + seeded randomized interleavings (300 runs); thinking-mode reasoning passback — all-or-nothing empty marker (Chat) + carry-forward `reasoning` item (Responses) on reasoningless tool-call turns, locked by deterministic agent-loop cases + seeded serialize properties                                                                 |
| `packages/cardo-provider/test/smoke.test.mjs`                  | Registration faces, credentials seam, settings write-point validation, dual-protocol parity, models.dev matching, RPC channel, per-model protocol pinning                                                                                                                                                                                                                                                                                                     |
| `packages/cardo-updater/test/decision.test.mts`                | Semver comparison incl. prereleases + unparseable→equal; update verdict merge; skip-prompt semantics; update-action mapping (Update Now → `cardo update`, Skip → persisted version, otherwise none)                                                                                                                                                                                                                                                           |
| `scripts/verify-cli-container/pbt/provisioning-pbt.test.mjs`   | Every workspace/vendored built-in ships the entry file its manifest points at; `BUNDLES_SET`; staleness detection; `ensureBuiltinPlugins` + real `dsh --profile web` boot to a 2xx readiness URL (300 s cap)                                                                                                                                                                                                                                                  |

## Test Conventions

- PBT-first: business logic is pinned as properties before fixes (`cardo-pbt-debugging`) and before implementation (`cardo-implement` failing-PBT red phase).
- Pure logic is extracted into packages without heavy imports (e.g. `cardo-updater` has no Electron/fs imports) so semantics are unit-testable.
- Deterministic randomness: seeded 32-bit PRNG for provider seeded properties.
- The container harness is hermetic — pristine source archive, no `.git`, no `node_modules`, `CI=true` install; no macOS runner required. The Windows harness verifies the real installer on windows-latest; both gate a release.

## Coverage

No coverage tooling configured. Invariant coverage is expressed through the PBT lanes above.

## How to Update

- New test lane / command → add a row to the Commands table.
- New invariant suite → add a row to the PBT Invariants table.
- Testing convention changes → update the Test Conventions section and `AGENTS.md`.

## Find It Fast

```bash
find packages scripts -name '*.test.*' -not -path '*/node_modules/*'  # every test file
```
