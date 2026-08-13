# Tech Stack

| Component           | Version       | Purpose                              | Notes                                                                                                                                                                                                |
| ------------------- | ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js             | >= 22         | Runtime                              | Pinned in `.nvmrc` / `engines`; ESM (`"type": "module"`)                                                                                                                                             |
| TypeScript          | ~5.9          | Language                             | Strict mode, NodeNext module resolution, project references (`tsc -b`)                                                                                                                               |
| pnpm                | 11.17.0       | Package manager                      | `pnpm-workspace.yaml`; `pnpm-lock.yaml`                                                                                                                                                              |
| pi-agent            | ^0.84.1       | Extension host + SDK                 | `@earendil-works/pi-coding-agent` — CLI (jiti extension loader) and in-process SDK (`createAgentSessionRuntime`, `ModelRuntime`)                                                                     |
| pi-ai               | ^0.84.1       | Model/auth types for the driver port | `@earendil-works/pi-ai` — `AuthInteraction`, `AuthPrompt`, `AuthEvent`, `CredentialInfo`                                                                                                             |
| typebox             | ^1.3.7        | Tool schema                          | `Type.Object` parameter schemas for `pi.registerTool()`                                                                                                                                              |
| pi-gui (vendored)   | 0.1.0-beta.33 | Desktop app shell                    | `vendor/pi-gui` — git subtree (MIT); Electron + `@pi-gui/pi-sdk-driver` + `@pi-gui/session-driver` + `@pi-gui/catalogs`; renderer styles are token-driven (see [design-system.md](design-system.md)) |
| Electron            | 37.10.3       | Desktop runtime (vendored)           | electron-vite build; main/preload/renderer; node-pty, photon-node (wasm) native deps                                                                                                                 |
| ESLint              | ^9.34         | Linter                               | `typescript-eslint` strictTypeChecked + extra strict rules; `vendor/` ignored                                                                                                                        |
| Prettier            | ^3.6          | Formatter                            | Single quotes, trailing commas, 100 width, LF; `vendor/` ignored                                                                                                                                     |
| husky + lint-staged | ^9 / ^16      | Pre-commit                           | `prettier --write` + `eslint --fix --max-warnings 0` on staged files                                                                                                                                 |

## Verified imports

- `@earendil-works/pi-coding-agent` — `packages/jovaltus/src/index.ts:29` (`ExtensionAPI`, `ExtensionContext`), `src/state.ts:30` (`getAgentDir`); `packages/runtime/src/index.ts` (`ExtensionFactory` type)
- `@earendil-works/pi-ai` — `vendor/pi-gui/packages/pi-sdk-driver/src/runtime-supervisor.ts` (`AuthEvent`, `AuthInteraction`, `AuthPrompt`)
- `typebox` — `packages/jovaltus/src/index.ts:32` (`Type`)
- Node built-ins only elsewhere: `node:fs`, `node:path`, `node:child_process`, `node:os`, `node:url`, `node:module`, `node:sqlite`, `node:crypto`

## Not present

- No web framework, no external database driver, no test framework (see `testing.md`), no CI config yet, no Docker. The jovaltus session store uses Node's built-in `node:sqlite` (`DatabaseSync`), so no database dependency is added.
- The vendored app brings its own toolchain (electron-vite, playwright, electron-builder) inside `vendor/pi-gui` — not cardo root deps.

## Version alignment

- pi-coding-agent must stay aligned between `packages/*` and `vendor/pi-gui` (both `^0.84.1`). After a `git subtree pull`, re-check; a split means two typebox/ExtensionAPI versions in the app process.

## How to Update

- New dependency → add row + verify the import actually appears in `src/` (config alone is not truth).
- Version bump → update the version column and the lockfile.
