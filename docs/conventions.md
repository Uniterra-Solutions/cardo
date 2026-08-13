# Conventions

Enforced by tooling (`eslint`, `prettier`, `tsc`); documented here because they are the project standard and must not be silently changed.

## Code Conventions

| Convention                                       | Rule                                                                                                                 | Enforced by                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Internal imports carry `.js` extension           | Required by NodeNext ESM resolution — never remove                                                                   | tsc (error if missing)        |
| No `any`                                         | `no-explicit-any: error`                                                                                             | ESLint                        |
| Named exports only                               | **Single exception:** `packages/jovaltus/src/index.ts` default-exported factory (pi loader contract)                 | AGENTS.md (not lint-enforced) |
| No unused vars/params                            | `noUnusedLocals`, `noUnusedParameters`, `no-unused-vars`                                                             | tsc + ESLint                  |
| Strict null/index checks                         | `strict`, `noUncheckedIndexedAccess`                                                                                 | tsc                           |
| Explicit function return types                   | `explicit-function-return-type: error`                                                                               | ESLint                        |
| No floating promises / misused promises          | `no-floating-promises`, `no-misused-promises`                                                                        | ESLint                        |
| Prefer `readonly`                                | `prefer-readonly: error`                                                                                             | ESLint                        |
| Exhaustive switches                              | `switch-exhaustiveness-check: error`                                                                                 | ESLint                        |
| Single quotes, trailing commas, 100 width, LF    | Prettier                                                                                                             | prettier + husky              |
| `void x;` to discard intentionally unused values | Required to satisfy no-unused-vars with `^_` ignore patterns                                                         | ESLint                        |
| App-consumed packages export built `dist`        | `@cardo/runtime` / `@cardo/jovaltus` exports point at `./dist/*` — Node cannot load TS source as an externalized dep | AGENTS.md (not lint-enforced) |

## Style Conventions

| Convention                             | Rule                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| Comments explain "why", not "what"     | Match existing module docstrings: intent, contract, port provenance            |
| Ported code keeps provenance note      | Modules state "Ported from the Hermes plugin's `src/jovaltus/<file>`"          |
| No default exports except the pi entry | All other modules export named symbols only                                    |
| Cardo patches in `vendor/` are marked  | `// Cardo:` comment on each minimal change; keep them small for subtree merges |

## Vendored code conventions (`vendor/pi-gui`)

- `vendor/` is upstream-managed via `git subtree` — cardo only makes minimal, `// Cardo:`-marked patches (integration seams, pi version alignment). Never run the vendored root's own `pnpm` scripts (`pnpm --dir vendor/pi-gui …`) — cardo's root is the single workspace root; run `pnpm --filter @pi-gui/…` from the repo root instead.
- pi-coding-agent must stay version-aligned between `packages/*` and `vendor/pi-gui` (currently both `^0.84.1`); the driver port lives in the subtree and must be re-applied on subtree updates if upstream still targets older pi.
- `eslint`/`prettier` ignore `vendor/` — upstream code is not subject to cardo's stricter rules.

## Testing Conventions

- No test framework installed (see `testing.md`).
- Any manual verification scripts must be hermetic: no real pi runtime, no LLM, no network.
- State-machine logic must be testable with an in-memory or temp-dir agent path; never write to the real `~/.pi/agent/jovaltus.sqlite` in tests.
- Session-store business logic (lifecycle, supersede, interrupt, resume) must be covered by the model-based invariants in `test/pbt/state-machine.test.mts`; new lifecycle semantics get a deterministic regression test too.

## Commit Conventions

- Gate before commit: `pnpm run lint` + `pnpm run typecheck` (AGENTS.md).
- Pre-commit runs `lint-staged`: prettier + eslint `--max-warnings 0` — any warning blocks the commit.
- Commit units are coherent (code / docs separated); see repo history for the established pattern.
- The vendored subtree has its own commits from `git subtree add/pull`; cardo changes to `vendor/` are committed separately from cardo package changes.

## Security Rules

- Never commit `.env` files or secrets (`.gitignore`).
- Extensions run with full system permissions — only install trusted sources (pi docs warning).
- State store `~/.pi/agent/jovaltus.sqlite` may contain repo paths — do not commit or print.
- `vendor/pi-gui` is MIT third-party code — keep the license attribution; review upstream changes on subtree pulls.

## How to Update

- Tooling rules changed → update the "Enforced by" column; keep this file in sync with `eslint.config.mjs` / `tsconfig.base.json`.
- New convention → add a falsifiable row an agent can check against code.
