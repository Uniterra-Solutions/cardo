# Module: uniterra-desktop

**Purpose:** Electron shell over the bundled DeepSeek Harness (dsh) CLI — supervises the dsh web server child and hosts its Web UI in a BrowserWindow. Uniterra IS the dsh desktop surface: it runs the bundled dsh against the user's normal dsh configuration; no app-owned home, no seeding, no profile scaffolding.

Source: `packages/uniterra-desktop/src/` (`main.ts`, `dsh-process.ts`, `builtin.ts`, `profile.ts`); packaging `electron-builder.yml`; tests `test/*.mjs`.

## Files

<<<<<<< HEAD

| File                                | Responsibility                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.ts`                       | Electron main entry: single-instance lock, dev test-home mirror, built-in provisioning, dsh child supervision + crash restart, BrowserWindow, startup update check, startup-failure log + dialog |
| `src/dsh-process.ts`                | dsh runtime supervision: spawn bundled CLI, await readiness URL, own shutdown                                                                                                                    |
| `src/builtin.ts`                    | Declarative `registerBuiltinPlugin()` registry: npm `dsh plugin add`, vendored/workspace copy, kind-aware staleness + retired heal, bundle rows                                                  |
| `src/profile.ts`                    | LEGACY manifest constants — not imported by `main.ts`/`builtin.ts`; consumed only by `test/profile.test.mjs`. Constants disagree with the live `builtin.ts` lists (see Gotchas). Do not extend.  |
| `scripts/electron-before-build.cjs` | electron-builder `beforeBuild` hook: returns `false` so node_modules are never reinstalled (the extracted source tree already has them)                                                          |

## Public API

`src/dsh-process.ts`:

| Symbol              | Signature                                                                 | Description                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DshRuntimeOptions` | `{ cli, nodeExec, dshHome?, dshBundledSkillDir?, profile, port?, args? }` | Spawn options                                                                                                                            |
| `DshRuntimeHandle`  | `{ url, child, exited: Promise<number \| null> }`                         | Live runtime handle                                                                                                                      |
| `awaitReadiness`    | `(stdout: Readable, timeoutMs = 60_000) => Promise<string>`               | Resolve first `http://127.0.0.1:<port>` URL on stdout; on timeout, SIGTERM child and reject with last 4000 chars of stderr               |
| `startDsh`          | `(options: DshRuntimeOptions) => Promise<DshRuntimeHandle>`               | Spawn `node <cli> --profile <profile>` with `DSH_HOME`, `DSH_BUNDLED_SKILL_DIR`, `ELECTRON_RUN_AS_NODE=1`, `NO_COLOR=1`; await readiness |
| `stopDsh`           | `(child: ChildProcess, timeoutMs = 10_000) => Promise<void>`              | SIGTERM, race exit vs timeout, SIGKILL if still alive                                                                                    |

`src/builtin.ts` — see [vendor-plugins.md](vendor-plugins.md) for the exact built-in lists and provisioning semantics; exports: `registerBuiltinPlugin` (declarative registry of `NpmBuiltin` / `CopyBuiltin` / `RetiredBuiltin` entries), `builtinPlugins`, `npmBuiltinSpecs`, `copyBuiltins`, `retiredBuiltinNames`, `builtinPackageName`, `expectedBuiltinBundles`, `hasAllBuiltins`, `copyBuiltinsStale` (unified vendored/workspace staleness), `removeRetiredBuiltins`, `ensureBuiltinPlugins`, `builtinSkillsDir` (exported but unused — `main.ts` uses its own `skillsDir()`).

## Boot Flow

`boot()` in `main.ts:313-372`, in order:

1. Single-instance lock; `second-instance` restores/focuses the window.
2. Profile resolution: `dev = !app.isPackaged`; dev mirrors `~/.dsh` → `userData/dsh-test-home` (config only, `node_modules` skipped); packaged omits `DSH_HOME` → real `~/.dsh`.
3. Built-ins: `ensureBuiltinPlugins(effectiveHome, 'web', dshCliPath(), process.execPath, vendorPluginsRoot(), bundledSrcRoot())`.
4. Skills: `skillsDir()` resolves `packages/uniterra-skills/src/skills` under the source root (dev AND packaged — the embedded source tree), passed as `DSH_BUNDLED_SKILL_DIR` (rank-600 provider) if it exists.
5. Update check scheduled after `UNITERRA_UPDATE_DELAY_MS` (default 5000 ms).
6. `startDsh({ profile: 'web', dshBundledSkillDir })`.
7. Crash-restart wiring: on runtime death with window alive, backoff restart `min(1000·2^restarts, 15_000)`.
8. `createWindow(handle.url)` — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
9. Lifecycle: `window-all-closed` → quit (even macOS — no dock daemon); `before-quit` → `stopDsh` + `app.exit(0)`; `activate` → recreate window from `runtime.url`.

Boot failure surfacing: any `boot()` rejection (initial boot or crash-restart) is routed through `reportStartupFailure` — it appends the error (including the dsh child's captured stderr, which `startDsh` folds into the message) to `userData/startup-error.log`, and on the FIRST boot also raises a native `dialog.showErrorBox` before `app.quit()`. Restart failures log only (no dialog spam).

## Path Resolution

| Resource                       | Dev                                                                  | Packaged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source root (`bundledSrcRoot`) | monorepo root (resolve from file)                                    | `process.resourcesPath/src` (whole repo embedded by `uniterra setup`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| dsh CLI (`dshCliPath`)         | `packages/uniterra-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js` | same, inside the embedded source (`Contents/Resources/src` on macOS, `resources/src` on Windows — both `process.resourcesPath`) — ALWAYS the desktop package's node_modules, never workspace root, never `vendor/dsh-runtime`. Windows resolves through the `.pnpm` store (`node_modules/.pnpm/@deepseek-ai+dsh@*/…`) as defense-in-depth: the installer now re-points the embedded junctions (see [uniterra-cli.md](uniterra-cli.md)), but the physical `.pnpm` location always resolves even if a junction is ever missing |
| Skills dir                     | `packages/uniterra-skills/src/skills` under source root              | same, inside the embedded source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Vendor plugins root            | `vendor/dsh-plugins` under source root                               | same, inside the embedded source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Update Check

`initUpdateChecker()` (`main.ts:278-291`) schedules `runUniterraStartupUpdateCheck()`: probes GitHub latest release + npm `latest` dist-tag in parallel, probes `uniterra --version` (3 s timeout). Verdicts via `@uniterra-solutions/uniterra-updater` (see [uniterra-updater.md](uniterra-updater.md)); the prompt response is mapped to the action by `resolveUpdateAction` and the spawn spec by `updateInvocation`. Overridable: `UNITERRA_UPDATE_API_BASE`, `UNITERRA_UPDATE_NPM_URL`, `UNITERRA_UPDATE_COMMAND`, `UNITERRA_UPDATE_RELEASES_PAGE`, `UNITERRA_UPDATE_DELAY_MS`. Prompt: Update Now / Later / Skip This Version (persisted to `userData/uniterra-update-state.json`). Update Now spawns the updater **detached before `app.quit()`** (so it survives the shutdown) — the default invocation is `npx --yes @uniterra-solutions/uniterra@latest update`, which always runs the LATEST updater and refreshes the CLI, rebuilds + reinstalls the app, and relaunches it when done: the relaunch IS the restart. (npm shims are `.cmd` on Windows — `shell: true` resolves them via PATHEXT.)

## Dependencies

- Inbound: `@uniterra-solutions/uniterra-cli` (packages it via electron-builder; not an npm import), `scripts/verify-cli-container` (builds + loads compiled `dist/`). No workspace package imports it as a library.
- Outbound: electron, `@uniterra-solutions/uniterra-updater` (only runtime workspace dep), node builtins. `@deepseek-ai/dsh` is NOT imported in TS — spawned as a child via the filesystem-resolved CLI path.

## Patterns & Gotchas

- `ELECTRON_RUN_AS_NODE=1` on both the dsh child spawn and `dsh plugin add` — the Electron binary runs as plain Node. `NO_COLOR=1` keeps stdout parse-friendly.
- Readiness regex requires a non-digit terminator (`(?=[^0-9])`) so a chunk boundary inside the port digits never yields a truncated URL — regression-locked in `builtin-pbt.test.mjs`.
- `ensureBuiltinPlugins` returns early when the profile dir doesn't exist — it enriches an existing profile, never scaffolds one.
- Vendored plugins are copied, not `dsh plugin add`-ed (peers only exist in the dsh source workspace); workspace built-ins ship pre-built with no pnpm install — a missing `packages/uniterra-provider/lib/` breaks boot (0.6.1 regression).
- Staleness is kind-aware in `copyBuiltinsStale()`: content identity against the pinned source for vendored copies, installed-vs-source `package.json` version for workspace copies — never bundle-list; a fixed distribution can ship under the same package name.
- `profile.ts` is legacy: `PROFILE_PLUGINS` lists 6 specs while `builtin.ts`'s live set is 9 npm + 2 vendored (+ 1 workspace); `profileManifest()` still has the scoped-name split bug `p.split('@')[0]` that `builtinPackageName` fixes. Do not use as a source of truth.
- `scripts/prepare-runtime.mjs` is orphaned (the 0.5.0 `vendor/dsh-runtime` model); its plugin list is inconsistent with `builtin.ts`. `vendor/dsh-runtime/` itself is a legacy snapshot not on the current boot path.
- No code signing: macOS sets `hardenedRuntime: false` + `identity: null` (no quarantine needed); Windows sets `signAndEditExecutable: false` — Uniterra ships unsigned, and skipping the sign step also stops electron-builder from downloading/extracting its `winCodeSign` tool, whose 7z archive contains macOS symlinks that 7-Zip cannot create on Windows without Developer Mode / administrator privileges (electron-builder#8149).
- On Windows the CLI probe and Update Now spawn npm shims (`uniterra` / `npx` as `.cmd`) with `shell: process.platform === 'win32'` — execFile cannot launch `.cmd` shims directly (`spawn ENOENT`); cmd.exe resolves them via PATHEXT (args are fixed, no quoting risk).

## Decisions

| Decision                                                                                     | Rationale                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Thin Electron window over the bundled dsh CLI; no reimplementation                           | Uniterra IS the dsh desktop surface — user's normal dsh config, no app-owned home                                                  |
| Dev mirrors `~/.dsh` to a test home; packaged uses the real one                              | Dev never touches the user's real config                                                                                           |
| Renderer fully sandboxed (`contextIsolation`, no nodeIntegration, `sandbox`)                 | dsh Web UI is a plain SPA on loopback                                                                                              |
| Copy vendored plugins instead of pnpm-installing                                             | Their peers aren't on npm                                                                                                          |
| Version-drift re-provisioning                                                                | Same package name can ship a fixed distribution (the whale-skin swap)                                                              |
| Whole source tree embedded in the app resources (`Contents/Resources/src` / `resources/src`) | Packaged app resolves everything from the embedded source — `process.resourcesPath` is platform-neutral                            |
| electron-builder never reinstalls node_modules                                               | The extracted tree already has them; reinstalling trips the root husky prepare                                                     |
| Quit on `window-all-closed` even on macOS                                                    | No dock-resident daemon — the runtime lives only while the window is open                                                          |
| Bounded exponential backoff on runtime crash (cap 15 s)                                      | Self-heal without a hot loop                                                                                                       |
| Startup failures written to `userData/startup-error.log` + first-boot dialog                 | A broken install must never fail as a silent 60 s hang — the child's stderr (the real `ERR_MODULE_NOT_FOUND`) surfaces to the user |

## How to Update

- Boot order / paths change → update Boot Flow and Path Resolution tables.
- New built-in added → see [vendor-plugins.md](vendor-plugins.md#how-to-update).
- Update-check wiring changes → update the Update Check section and [uniterra-updater.md](uniterra-updater.md).

## Find It Fast

```bash
grep -n 'async function boot' packages/uniterra-desktop/src/main.ts  # boot flow
grep -n 'export function' packages/uniterra-desktop/src/dsh-process.ts packages/uniterra-desktop/src/builtin.ts
```
