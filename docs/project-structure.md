# Project Structure

Directory map for the cardo monorepo. Locate code by task, not by grepping.

## Root

| Path                                                         | Responsibility                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*`                                                 | pnpm workspace packages (6 packages, see below)                                                                                                                 |
| `vendor/dsh-plugins/`                                        | Pinned community dsh plugins not on npm (5 plugins; `VENDOR.md` pin ledger)                                                                                     |
| `vendor/dsh-runtime/`                                        | LEGACY 0.5.0 runtime snapshot — not on the current boot path (the app resolves the dsh CLI from `packages/cardo-desktop/node_modules`); keep for reference only |
| `scripts/verify-cli-container/`                              | Docker harness replaying the `cardo setup` flow in a clean container                                                                                            |
| `scripts/verify-windows-install/`                            | PowerShell harness: real `cardo setup --source` + `Cardo.exe` boot smoke on windows-latest (release gate)                                                       |
| `AGENTS.md`                                                  | Company-standard agent rules (the coding rulebook)                                                                                                              |
| `CHANGELOG.md`                                               | Keep a Changelog + SemVer                                                                                                                                       |
| `eslint.config.mjs` / `tsconfig.base.json` / `tsconfig.json` | Shared lint / compile rules; every package extends them                                                                                                         |
| `.github/workflows/ci.yml`                                   | PR regression net: parallel lint / typecheck / tests; callable from the release workflow                                                                        |
| `.github/workflows/release.yml`                              | `v*` tag release: gates publish on ci + container + windows verification, then CLI npm publish (OIDC) + GitHub Release                                          |

## Workspace Packages

| Package                       | Responsibility                                                                 | Key files                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `packages/cardo-desktop`      | Electron shell: boots the bundled dsh CLI, hosts its Web UI, ensures built-ins | `src/main.ts`, `src/dsh-process.ts`, `src/profile.ts`, `src/builtin.ts`, `scripts/prepare-runtime.mjs` |
| `packages/cardo-provider`     | In-house dual-protocol LLM provider plugin (chat completions + Responses API)  | `src/index.ts`, `src/adapter.ts`, `src/serialize-*.ts`, `src/translate-*.ts`, `src/client/*`           |
| `packages/cardo-cli`          | Public npm installer (`cardo` bin): `setup` / `update` — macOS + Windows       | `src/cli.ts`, `src/install-logic.ts`                                                                   |
| `packages/cardo-updater`      | Pure update-check decision logic (no Electron imports)                         | `src/index.ts`, `src/decision.ts`                                                                      |
| `packages/cardo-skills`       | Built-in skill registry (10 company skills) + provisioning                     | `src/index.ts`, `src/skills/*/SKILL.md`, `scripts/copy-skills.mjs`                                     |
| `packages/cardo-systemprompt` | pi-agent extension appending app-wide working rules to every turn              | `src/index.ts`                                                                                         |

## Built-in Skills (`packages/cardo-skills/src/skills/`)

| Skill dir               | Purpose                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cardo-plan`            | Planning phase: clarify → PRD/design subagents → execution-plan.json with per-task requirements → user approval                                              |
| `cardo-implement`       | PBT-first execution: simple tasks inline; complex tasks write ALL failing PBTs then batched/full-parallel dynamic workflow                                   |
| `cardo-simplify`        | Scope-bound simplification review: explicit review scope → fix ↔ simplify-review dynamic workflow loop                                                       |
| `cardo-review`          | Scope-bound adversarial review: explicit review scope → fix ↔ adversarial-review dynamic workflow loop                                                       |
| `cardo-pbt-debugging`   | Invariant-first debugging: pin business logic as properties, reproduce the bug, fix, lock with regression tests                                              |
| `project-documentation` | Generate/maintain the structured `docs/` tree                                                                                                                |
| `cardo-qa`              | PRD-driven acceptance testing: UI apps = playwright geometry + pixel checks then UI operation; backend = clean-container install + smoke boot + API journeys |
| `create-skill`          | Scaffold a new agent skill                                                                                                                                   |
| `manage-agents-md`      | Create/audit agent spec files (AGENTS.md etc.)                                                                                                               |
| `manage-git-repo`       | Commit, version, release, PR workflows                                                                                                                       |

## Vendored Plugins (`vendor/dsh-plugins/`)

| Dir              | Package name                                  | Purpose                                                 |
| ---------------- | --------------------------------------------- | ------------------------------------------------------- |
| `dsh-deep-whale` | @dsh-external/dsh-client-ui-skin-maid-atelier | Whale-maid UI skin (standalone distribution)            |
| `dsh-shortcuts`  | dsh-shortcuts                                 | 34 keyboard shortcuts, one-click recording, macOS-first |

## Build Outputs (gitignored)

| Path                                 | Produced By                                             | Consumed By                                                    |
| ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/*/dist/`                   | `tsc -b`                                                | Desktop (via `@cardo/*` exports pointing at `dist`)            |
| `packages/cardo-provider/lib/`       | esbuild (`scripts/build-host.mjs` + `build-client.mjs`) | Workspace built-in provisioning copies `lib/` into the profile |
| `packages/cardo-skills/dist/skills/` | `scripts/copy-skills.mjs`                               | Packaged `resources/skills` (rank-600 bundled skill provider)  |

## How to Update

- Directory added/removed/repurposed → update the corresponding table row.
- New skill under `src/skills/` → add a row to the Built-in Skills table.
- New vendored plugin → add to `vendor/dsh-plugins/` + update `VENDOR.md` pin ledger and this table.

## Find It Fast

```bash
find packages -maxdepth 2 -name package.json    # all workspace manifests
ls packages/cardo-skills/src/skills/            # bundled skills
```
