# Conventions

Enforced by tooling (`eslint`, `prettier`, `tsc`); documented here because they are the project standard and must not be silently changed.

## Code Conventions

| Convention                                       | Rule                                                                                                 | Enforced by                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| Internal imports carry `.js` extension           | Required by NodeNext ESM resolution — never remove                                                   | tsc (error if missing)        |
| No `any`                                         | `no-explicit-any: error`                                                                             | ESLint                        |
| Named exports only                               | **Single exception:** `packages/jovaltus/src/index.ts` default-exported factory (pi loader contract) | AGENTS.md (not lint-enforced) |
| No unused vars/params                            | `noUnusedLocals`, `noUnusedParameters`, `no-unused-vars`                                             | tsc + ESLint                  |
| Strict null/index checks                         | `strict`, `noUncheckedIndexedAccess`                                                                 | tsc                           |
| Explicit function return types                   | `explicit-function-return-type: error`                                                               | ESLint                        |
| No floating promises / misused promises          | `no-floating-promises`, `no-misused-promises`                                                        | ESLint                        |
| Prefer `readonly`                                | `prefer-readonly: error`                                                                             | ESLint                        |
| Exhaustive switches                              | `switch-exhaustiveness-check: error`                                                                 | ESLint                        |
| Single quotes, trailing commas, 100 width, LF    | Prettier                                                                                             | prettier + husky              |
| `void x;` to discard intentionally unused values | Required to satisfy no-unused-vars with `^_` ignore patterns                                         | ESLint                        |

## Style Conventions

| Convention                             | Rule                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| Comments explain "why", not "what"     | Match existing module docstrings: intent, contract, port provenance   |
| Ported code keeps provenance note      | Modules state "Ported from the Hermes plugin's `src/jovaltus/<file>`" |
| No default exports except the pi entry | All other modules export named symbols only                           |

## Testing Conventions

- No test framework installed (see `testing.md`).
- Any manual verification scripts must be hermetic: no real pi runtime, no LLM, no network.
- State-machine logic must be testable with an in-memory or temp-dir agent path; never write to the real `~/.pi/agent/jovaltus.json` in tests.

## Commit Conventions

- Gate before commit: `pnpm run lint` + `pnpm run typecheck` (AGENTS.md).
- Pre-commit runs `lint-staged`: prettier + eslint `--max-warnings 0` — any warning blocks the commit.
- Commit units are coherent (code / docs separated); see repo history for the established pattern.

## Security Rules

- Never commit `.env` files or secrets (`.gitignore`).
- Extensions run with full system permissions — only install trusted sources (pi docs warning).
- State file `~/.pi/agent/jovaltus.json` may contain repo paths — do not commit or print.

## How to Update

- Tooling rules changed → update the "Enforced by" column; keep this file in sync with `eslint.config.mjs` / `tsconfig.base.json`.
- New convention → add a falsifiable row an agent can check against code.
