# Conventions

Company-standard rules from `AGENTS.md`, `eslint.config.mjs`, `tsconfig.base.json`. Every rule is falsifiable against the code.

## Language / Module System

| Rule                                                                                       | Enforcement                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node ≥ 22 (`.nvmrc` / `engines`)                                                           | Manual                                                                                                                                                     |
| NodeNext ESM: internal imports carry `.js` extensions                                      | Node runtime failure                                                                                                                                       |
| Named exports only; no default exports                                                     | Manual (AGENTS.md rule); single platform exception: `packages/uniterra-systemprompt/src/index.ts` default-exports a factory (pi extension loader contract) |
| No `any`                                                                                   | ESLint `no-explicit-any: error`                                                                                                                            |
| Explicit function return types                                                             | ESLint `explicit-function-return-type: error`                                                                                                              |
| Readonly-by-default (`prefer-readonly`), exhaustive switches, no floating/misused promises | ESLint strictTypeChecked + extra rules                                                                                                                     |

## TypeScript Config (shared)

`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `module/moduleResolution: NodeNext`, `target/lib: ES2022`, `isolatedModules`, `rootDir: ${configDir}/src`, `outDir: ${configDir}/dist`. Every package extends it.

## Dependencies

| Rule                                                                                                     | Reason                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin all `@deepseek-ai/*` at exact versions (no caret)                                                    | dsh is a developer preview with breaking changes; `npm view X version` returns the stale `latest` tag — current family is on the `next` tag |
| `pnpm install --frozen-lockfile` in CI (never bare `pnpm install`)                                       | Reproducible installs                                                                                                                       |
| `@uniterra-solutions/*` exports point at built `dist` (never `./src`)                                    | Desktop consumes them as externalized deps; Node cannot load TS source                                                                      |
| Exception: `@uniterra-solutions/uniterra-provider` exports point at `lib/` (esbuild bundle), not `dist/` | Self-contained host bundle ships into the profile; `eslint.config.mjs` ignores `**/lib/` alongside `**/dist/`                               |
| Ask before adding new dependencies / changing lint or tsconfig rules                                     | They encode the company standard                                                                                                            |

## Formatting (Prettier)

Single quotes, trailing commas, print width 100, LF line endings. Run `pnpm format`; CI-adjacent gate is `pnpm format:check`.

## Git / Commits

- Commit messages: imperative subject line; Conventional-Commit style used in practice (`feat:`, `fix:`, `chore(release):` — see `CHANGELOG.md`).
- Pre-commit: `.husky/pre-commit` runs `lint-staged` — `*.{ts,tsx}` → `prettier --write` + `eslint --fix --max-warnings 0`; `*.{json,md,yaml,yml}` → `prettier --write`. Any ESLint warning/error blocks the commit.
- Never commit `.env` files or secrets; never edit `generated/` or `node_modules/`.
- Never edit `vendor/dsh-plugins/` in place — bump via the `VENDOR.md` update policy.
- Root `prepare` script is `husky || true` — GitHub source tarballs ship no `.git`, so husky must tolerate absence.

## Testing

| Rule                                                               | Detail                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests per business logic                                           | Every business-logic change ships with tests; property-based tests (fast-check) pin invariants                                                                                                                                                                                                                                                                             |
| Review regression tests are permanent                              | `uniterra-review`'s review agent (which confirms each finding by writing a failing test before reporting it) writes each failing test to the repo's conventional test location with a descriptive, invariant-based name (never a finding id), matching the package's test framework and lint conventions; the fix agent turns them green but never deletes or renames them |
| Test lanes per package                                             | `pnpm --filter <pkg> test` builds first, then runs `node --test` on the compiled output                                                                                                                                                                                                                                                                                    |
| Hermetic verification                                              | `scripts/verify-cli-container/run.sh` replays the installer flow in Docker (no macOS runner needed); Windows branches are exercised by `scripts/verify-windows-install/verify.ps1` on windows-latest — both gate a release                                                                                                                                                 |
| PBT-first bug fixes                                                | See [modules/uniterra-skills.md](modules/uniterra-skills.md#uniterra-pbt-debugging) and [workflows.md](workflows.md#debug-a-bug-pbt-first)                                                                                                                                                                                                                                 |
| Bundled workflow templates follow the dsh `workflow` tool contract | Every template must instruct `meta` (`name` + `description`) as a separate required tool parameter — never `export const meta` in the script body, and no meta field beyond name/description/whenToUse/phases (`META_INVALID`); enforced by `packages/uniterra-skills/test/workflow-templates.test.mts` (parse + execution under the engine contract)                      |

## Build / Distribution

| Rule                                                        | Detail                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop resolves consumed packages via their `dist` exports | After changing `uniterra-systemprompt`, `uniterra-skills`, or `uniterra-updater` source, run `pnpm run build`                                                           |
| Provider ships via `lib/`                                   | After changing `uniterra-provider` source, run `pnpm run build` (tsc + esbuild) or the profile ships a stale plugin                                                     |
| Skills refresh via `copy-skills.mjs`                        | After changing `src/skills/*`, run `pnpm run build`; stale entries are removed so deleted skills stop shipping                                                          |
| Installer-flow changes                                      | After changing `uniterra setup` flow or root scripts, run `scripts/verify-cli-container/run.sh`; Windows branches are re-verified by the release gate on windows-latest |

## How to Update

- New convention adopted → add a row to the matching table here and to `AGENTS.md` (AGENTS.md is the rulebook; this file mirrors the falsifiable subset).
- ESLint/Prettier/tsconfig change → ask first, then update this file and the tool config together.

## Find It Fast

```bash
grep -n '"@deepseek-ai/' packages/*/package.json   # exact-version pin check
grep -rn 'no-explicit-any' eslint.config.mjs       # any-ban rule
```
