# Module: cardo-cli

**Purpose:** Public npm installer (`@uniterra-solutions/cardo`, bin `cardo`) — one-command desktop app setup and update for macOS and Windows, building the app from the release's source (prebuilt asset when available, else the auto-generated archive) on the user's machine.

Source: `packages/cardo-cli/src/` (`cli.ts`, `install-logic.ts`); tests `test/pbt.test.mts`.

## Public API

`cardo` commands:

| Command                            | Flags                                      | Behavior                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cardo setup`                      | `--source <dir>`, `--no-open`, `--dry-run` | Full install: fetch release (or build a `--source` local checkout) → `pnpm install --frozen-lockfile` → build (skipped when the prebuilt marker is present) → package (`--mac` → `Cardo.app` / `--win --dir` → `win-unpacked/`) → embed source → install (macOS `~/Applications/Cardo.app`; Windows `%LOCALAPPDATA%\Programs\Cardo` + Start Menu shortcut) → launch (unless `--no-open`) |
| `cardo update`                     | `--source <dir>`, `--no-open`, `--dry-run` | One-command full update: `npm install -g @uniterra-solutions/cardo@latest` (CLI self-update, fail fast), then the exact `cardo setup` build/install flow, then relaunch the app (unless `--no-open`) — the desktop's Update Now quits the app and runs this, so the relaunch is the restart                                                                                              |
| `cardo --version` / `-v`           | —                                          | Print CLI version from `package.json`                                                                                                                                                                                                                                                                                                                                                    |
| `cardo --help` / `-h` / no command | —                                          | Print help                                                                                                                                                                                                                                                                                                                                                                               |

Errors: any thrown error → `cardo: <message>` on stderr, exit `1` (`cli.ts`).

Exported from `install-logic.ts`:

| Export                       | Signature                                            | Description                                                                                                                                |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `REPO`                       | `string`                                             | `process.env.CARDO_GITHUB_REPO ?? 'Uniterra-Solutions/cardo'`                                                                              |
| `currentPlatform`            | `() => InstallPlatform`                              | `'windows'` on win32, else `'macos'` (the CLI only targets the two)                                                                        |
| `sourceArchiveUrl`           | `(tag: string) => string`                            | GitHub auto-generated tarball URL `https://github.com/<repo>/archive/refs/tags/<tag>.tar.gz` (the fallback)                                |
| `sourceAssetName`            | `(tag: string) => string`                            | `cardo-src-<tag>.tar.gz` — the release asset carrying the built tree                                                                       |
| `sourceDownloadUrl`          | `(tag, assets) => string`                            | The matching asset's URL, else `sourceArchiveUrl`; PBT-locked (asset wins at any position)                                                 |
| `hasPrebuiltSource`          | `(root: string) => Promise<boolean>`                 | True iff the `.cardo-prebuilt` marker is at the root — the marker alone decides the build skip; PBT-locked                                 |
| `embedStrategy`              | `(platform, downloaded) => 'move' \| 'copy'`         | `move` only for a downloaded Windows source (same-volume rename fast path); `--source`/macOS always `copy`; PBT-locked                     |
| `commandErrorMessage`        | `(message, code, stderr, stdout) => string`          | Subprocess-failure message: command line + exit code + captured output (never swallows the real reason); PBT-locked                        |
| `pnpmVersionFromPackageJson` | `(packageJson) => string \| undefined`               | Reads the `packageManager` pin (`pnpm@x.y.z` → `x.y.z`)                                                                                    |
| `pnpmInvocation`             | `(pnpmOnPath, version) => { file, args }`            | `pnpm` when on PATH; else `npx --yes pnpm@<version>` (self-provisions the pinned pnpm); throws if missing with no pin; PBT-locked          |
| `findSourceRoot`             | `(dir: string) => Promise<string>`                   | Exactly one `cardo-*` dir after extract, else throw                                                                                        |
| `findBuiltApp`               | `(src: string, platform?) => Promise<string>`        | macOS: first `*.app` under any `mac-*` dir; Windows: `win-unpacked/` dir containing an `.exe`; else throw                                  |
| `installDestination`         | `(platform, env, appPath) => string`                 | macOS `~/Applications/<basename>`; Windows `%LOCALAPPDATA%\Programs\Cardo` (`~/AppData/Local` fallback)                                    |
| `launchTarget`               | `(platform, destination) => string`                  | The `.app` itself / `Cardo.exe` inside the Windows install dir                                                                             |
| `embedResourcesDir`          | `(platform, appRoot) => string`                      | `Contents/Resources` / `resources` — both are `process.resourcesPath` at runtime                                                           |
| `builderArgs`                | `(platform, version) => readonly string[]`           | `--mac` vs `--win --dir`, plus `--publish never` and the version stamp                                                                     |
| `startMenuShortcut`          | `(exePath, env) => { lnkPath, script }`              | Start Menu `.lnk` path + WScript.Shell PowerShell script (single quotes escaped)                                                           |
| `psSingleQuote`              | `(value: string) => string`                          | `'` → `''` escape for single-quoted PowerShell strings                                                                                     |
| `readVersion`                | `(pkgPath?) => Promise<string>`                      | Regex-read `version` from package.json                                                                                                     |
| `parseArgs`                  | `(args: readonly string[]) => ParsedArgs`            | `{ command, open, dryRun, source? }`; `--source <dir>` consumes the next token (missing value throws); PBT-locked                          |
| `installPlan`                | `(command, open, dryRun) => readonly InstallStage[]` | `update` = `update-cli` → `build-install-app` → (`launch-app` iff open); `setup` = the same minus `update-cli`; dry-run = `[]`; PBT-locked |

## Setup / Update Flow

Both commands execute the same stage plan (`installPlan`, PBT-locked); `cardo update` prepends the CLI self-update stage. `runInstallPlan` (`cli.ts`) dispatches the stages; `buildInstallApp` covers steps 2–14:

1. `update-cli` (`cardo update` only, runs FIRST — before the long build, so npm/permission problems surface immediately): `npm install -g @uniterra-solutions/cardo@latest`.
2. Resolve source: `--source <dir>` (validated by `packages/cardo-desktop/package.json`; version read from that package.json) — or fetch latest release (404 → `releases?per_page=1` fallback), download the prebuilt source asset `cardo-src-<tag>.tar.gz` when the release carries it (else the auto-generated archive), extract (`/usr/bin/tar` macOS / `tar` from PATH Windows — Win10+ ships bsdtar), locate the `cardo-*` root.
3. `--dry-run` short-circuits here (the plan is empty): `cardo update --dry-run` prints the full update plan and stops — no downloads at all (deterministic/offline); `cardo setup --dry-run` still resolves the source to print its report (no install).
4. Resolve pnpm (`resolvePnpm`): probe `pnpm --version`; if absent, `npx --yes pnpm@<pin>` (the pin comes from the source tree's `packageManager`) — the CLI runs on node, so node+npm/npx are guaranteed and pnpm is self-provisioned.
5. `pnpm install --frozen-lockfile` with `CI: 'true'` (pnpm 11 aborts without a TTY).
6. `pnpm run build` — skipped when `hasPrebuiltSource` is true (the asset ships CI-built dist/lib; old releases and `--source` checkouts build as before).
7. Package: `pnpm exec electron-builder <builderArgs(platform, version)>` in `packages/cardo-desktop`.
8. `findBuiltApp(platform)`: the `.app` under `dist/mac-*` / the `win-unpacked` dir.
9. Move the artifact out of the tree (embedding the source into itself is illegal): `/bin/mv` (macOS, cross-volume safe) / `fs.rename` with EXDEV fallback to `robocopy` + `rm` (Windows — CI workspaces can live on another volume than the temp dir).
10. Embed source: `/bin/cp -R <src> <app>/Contents/Resources/src` / Windows `embedStrategy` — a downloaded source is a same-volume `fs.rename` (instant, `robocopy /MT:16` fallback), a `--source` checkout is always `robocopy`-copied — the tree the packaged app resolves everything from (the pnpm store is hundreds of thousands of small files).
11. Install: `/usr/bin/ditto` → `~/Applications/Cardo.app` / same-volume `fs.rename` → `%LOCALAPPDATA%\Programs\Cardo` (tmp and LOCALAPPDATA are both on C:, so the multi-GB move is instant; ANY rename failure — EXDEV cross-volume, EPERM locked files — falls back to `robocopy /MT:16 /R:5 /W:5`), replacing any existing copy.
12. Windows only: Start Menu shortcut via `powershell` WScript.Shell (best-effort — a missing shortcut never fails the install).
13. `launch-app` (unless `--no-open`): `/usr/bin/open` / detached spawn of `Cardo.exe` — after an update this relaunch is the app restart.
14. `finally`: remove the temp root.

Platform notes:

- macOS tools are absolute `/usr/bin` paths; Windows tools (`tar`, `robocopy`, `powershell`) resolve from PATH.
- `robocopy` exit codes 0–7 are success (bitmask); `run()` is bypassed for it — a non-zero code is not a failure. Runs with `/MT:16` (parallel threads) and is only the copy engine when a same-volume rename is impossible.
- `run()` on Windows uses `shell: true` (args quoted for cmd.exe via `cmdQuote`): npm/pnpm/cardo ship as `.cmd` shims that execFile cannot launch directly (`spawn ENOENT`); cmd.exe resolves them via PATHEXT. `.exe` tools (`tar`, `robocopy`, `powershell`) would resolve either way.
- `.app` discovery accepts any `mac-*` dir (host arch chosen by electron-builder `[INFERRED]`); Windows expects `win-unpacked/` with an `.exe` (any name).

## Decisions

| Decision                                                                         | Rationale                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Source is the artifact — CI prebuilds it into the asset, the CLI skips the build | Matches the repo exactly; skips the multi-minute tsc/esbuild on user machines               |
| Asset absent → auto-generated archive fallback                                   | Releases predating the asset keep building from the raw tarball                             |
| Windows ships `win-unpacked/` (`--win --dir`), not NSIS                          | The source is embedded AFTER packaging; an installer image can't carry it                   |
| Windows installs per-user under `%LOCALAPPDATA%\Programs\Cardo`                  | No elevation needed; mirrors `~/Applications`                                               |
| Start Menu shortcut is best-effort                                               | A missing shortcut must never fail the install                                              |
| `--source <dir>` local checkout mode                                             | Windows CI verifies the REAL CLI end-to-end without downloading a release                   |
| `cardo update` = CLI self-update + full rebuild + relaunch (one command)         | The desktop's Update Now quits and runs exactly this — no separate `cardo setup` for users  |
| `cardo update` refreshes the CLI FIRST                                           | npm/permission problems fail fast, before the multi-minute build                            |
| `CI=true` injected into pnpm install                                             | pnpm 11 aborts without a TTY                                                                |
| pnpm self-provisioned via `npx pnpm@<pin>` when absent                           | The CLI runs on node (npm/npx bundled), so pnpm is the only runtime dep that can be missing |
| Subprocess failures surface stderr + exit code                                   | `electron-builder`'s real reason (e.g. a binary download) must never be swallowed           |
| `/releases/latest` 404 → fall back to `releases?per_page=1`                      | `/releases/latest` excludes prereleases; beta tags must still install                       |
| `CARDO_GITHUB_REPO` env override                                                 | Point the installer at a fork/mirror in tests                                               |
| Version stamp: release tag without `v`; `--source`: source desktop version       | Align app metadata with the release tag                                                     |

## Dependencies

- Outbound: node builtins (`fs`, `child_process`, `stream`), platform tools (macOS `/usr/bin/*`; Windows `tar`/`robocopy`/`powershell`), GitHub API, npm registry.
- Inbound: none in-repo (leaf package; the desktop does NOT import it).

## Patterns & Gotchas

- macOS subprocesses use absolute `/usr/bin` paths — never rely on PATH there; Windows resolves tools from PATH (`.exe` directly, `.cmd` shims through `shell: true` + PATHEXT).
- PBT (`test/pbt.test.mts`) locks arg parsing (`--source` consumption included), the `installPlan` stage order (`update` = CLI refresh → rebuild → relaunch; `setup` never touches the CLI; dry-run runs nothing), `.app` + `win-unpacked` discovery, install destinations, builder args, shortcut script quoting, the prebuilt-asset selection (matching asset wins at any position, else the auto-archive fallback), the marker→skip-build decision, `embedStrategy` (only a downloaded Windows source moves), `commandErrorMessage` (command line + exit code + captured output), and pnpm self-provisioning (`pnpm` vs `npx pnpm@<pin>`; unknown pin throws).
- `prepack` runs `pnpm run build` so npm ships a freshly compiled `dist/`.

## How to Update

- New command/flag → update the Public API table + `parseArgs` PBT.
- Install steps change → update the Setup Flow list, run `scripts/verify-cli-container/run.sh` (Linux container), and re-run `scripts/verify-windows-install/verify.ps1` via the release gate (windows-latest).

## Find It Fast

```bash
grep -n 'export function' packages/cardo-cli/src/install-logic.ts  # public helpers
grep -n 'case ' packages/cardo-cli/src/cli.ts                      # command dispatch
```
