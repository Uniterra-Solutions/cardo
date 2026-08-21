# Project Structure

Directory map for the uniterra monorepo. Locate code by task, not by grepping.

## Root

| Path                                                         | Responsibility                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*`                                                 | pnpm workspace packages (6 packages, see below)                                                                                                                                                            |
| `vendor/dsh-plugins/`                                        | Pinned community dsh plugins not on npm (5 plugins; `VENDOR.md` pin ledger)                                                                                                                                |
| `vendor/dsh-runtime/`                                        | LEGACY 0.5.0 runtime snapshot — not on the current boot path (the app resolves the dsh CLI from `packages/uniterra-desktop/node_modules`); keep for reference only                                         |
| `scripts/verify-cli-container/`                              | Docker harness replaying the `uniterra setup` flow in a clean container                                                                                                                                    |
| `scripts/verify-windows-install/`                            | PowerShell harness: real `uniterra setup --source --move-source` (closer-to-real flow: the source is move-embedded like a downloaded release) + `Uniterra.exe` boot smoke on windows-latest (release gate) |
| `AGENTS.md`                                                  | Company-standard agent rules (the coding rulebook)                                                                                                                                                         |
| `CHANGELOG.md`                                               | Keep a Changelog + SemVer                                                                                                                                                                                  |
| `eslint.config.mjs` / `tsconfig.base.json` / `tsconfig.json` | Shared lint / compile rules; every package extends them                                                                                                                                                    |
| `.github/workflows/ci.yml`                                   | PR regression net: parallel lint / typecheck / tests; callable from the release workflow                                                                                                                   |
| `.github/workflows/release.yml`                              | `v*` tag release: gates publish on ci + container + windows verification, then CLI npm publish (OIDC) + GitHub Release                                                                                     |

## Workspace Packages

| Package                          | Responsibility                                                                 | Key files                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `packages/uniterra-desktop`      | Electron shell: boots the bundled dsh CLI, hosts its Web UI, ensures built-ins | `src/main.ts`, `src/dsh-process.ts`, `src/builtin.ts`                                        |
| `packages/uniterra-provider`     | In-house dual-protocol LLM provider plugin (chat completions + Responses API)  | `src/index.ts`, `src/adapter.ts`, `src/serialize-*.ts`, `src/translate-*.ts`, `src/client/*` |
| `packages/uniterra-cli`          | Public npm installer (`uniterra` bin): `setup` / `update` — macOS + Windows    | `src/cli.ts`, `src/install-logic.ts`                                                         |
| `packages/uniterra-updater`      | Pure update-check decision logic (no Electron imports)                         | `src/index.ts`, `src/decision.ts`                                                            |
| `packages/uniterra-skills`       | Built-in skill registry (10 company skills) + provisioning                     | `src/index.ts`, `src/skills/*/SKILL.md`, `scripts/copy-skills.mjs`                           |
| `packages/uniterra-systemprompt` | pi-agent extension appending app-wide working rules to every turn              | `src/index.ts`                                                                               |

## Built-in Skills (`packages/uniterra-skills/src/skills/`)

| Skill dir                | Purpose                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uniterra-plan`          | Planning phase: clarify requirements + design interactively → write prd.md / design.md / acceptance.md → confirm the plan with the user → 3 parallel review agents → repair agent applies failing issues → re-review only the failed axes until all pass |
| `uniterra-implement`     | PBT-first execution: write ALL failing PBTs → decompose into a task list → batched / full-parallel workflow of subagents                                                                                                                                 |
| `uniterra-simplify`      | Behaviour-preserving simplification: goal + context → review (over-engineering checklist — plan design is authoritative; pass/fail verdict) → fix → re-review loop until pass                                                                            |
| `uniterra-review`        | Adversarial review: goal + context → review (correctness + security; pass/fail verdict; each finding confirmed by a failing test — only confirmed findings reported) → fix → re-review loop until pass                                                   |
| `uniterra-pbt-debugging` | Invariant-first debugging: pin business logic as properties, reproduce the bug, fix, lock with regression tests                                                                                                                                          |
| `project-documentation`  | Generate/maintain the structured `docs/` tree                                                                                                                                                                                                            |
| `uniterra-qa`            | PRD-driven acceptance testing: UI apps = playwright geometry + pixel checks then UI operation; backend = clean-container install + smoke boot + API journeys                                                                                             |
| `manage-agents-md`       | Create/audit agent spec files (AGENTS.md etc.)                                                                                                                                                                                                           |
| `manage-git-repo`        | Commit, version, release, PR workflows                                                                                                                                                                                                                   |

## Vendored & Optional Plugins (`vendor/dsh-plugins/`)

| Kind     | Dir              | Package name                                  | Purpose                                                                   |
| -------- | ---------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| optional | `dsh-deep-whale` | @dsh-external/dsh-client-ui-skin-maid-atelier | Whale-maid UI skin (standalone distribution; opt-in via `.uniterra.json`) |
| vendored | `dsh-shortcuts`  | dsh-shortcuts                                 | 34 keyboard shortcuts, one-click recording, macOS-first                   |

## Build Outputs (gitignored)

| Path                                    | Produced By                                             | Consumed By                                                      |
| --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/*/dist/`                      | `tsc -b`                                                | Desktop (via `@uniterra-solutions/*` exports pointing at `dist`) |
| `packages/uniterra-provider/lib/`       | esbuild (`scripts/build-host.mjs` + `build-client.mjs`) | Workspace built-in provisioning copies `lib/` into the profile   |
| `packages/uniterra-skills/dist/skills/` | `scripts/copy-skills.mjs`                               | Packaged `resources/skills` (rank-600 bundled skill provider)    |

## How to Update

- Directory added/removed/repurposed → update the corresponding table row.
- New skill under `src/skills/` → add a row to the Built-in Skills table.
- New vendored plugin → add to `vendor/dsh-plugins/` + update `VENDOR.md` pin ledger and this table.

## Find It Fast

```bash
find packages -maxdepth 2 -name package.json    # all workspace manifests
ls packages/uniterra-skills/src/skills/            # bundled skills
```
