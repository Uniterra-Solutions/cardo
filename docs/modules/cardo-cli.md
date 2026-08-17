# Module: cardo-cli

**Purpose:** Public npm installer (`@uniterra-solutions/cardo`, bin `cardo`) — one-command desktop app setup and update for macOS and Windows, building the app from the release's source archive on the user's machine.

Source: `packages/cardo-cli/src/` (`cli.ts`, `install-logic.ts`); tests `test/pbt.test.mts`.

## Public API

`cardo` commands:

| Command                            | Flags                                      | Behavior                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cardo setup`                      | `--source <dir>`, `--no-open`, `--dry-run` | Full install: fetch release (or build a `--source` local checkout) → `pnpm install --frozen-lockfile` → build → package (`--mac` → `Cardo.app` / `--win --dir` → `win-unpacked/`) → embed source → install (macOS `~/Applications/Cardo.app`; Windows `%LOCALAPPDATA%\Programs\Cardo` + Start Menu shortcut) → launch (unless `--no-open`) |
| `cardo update`                     | `--source <dir>`, `--no-open`, `--dry-run` | One-command full update: `npm install -g @uniterra-solutions/cardo@latest` (CLI self-update, fail fast), then the exact `cardo setup` build/install flow, then relaunch the app (unless `--no-open`) — the desktop's Update Now quits the app and runs this, so the relaunch is the restart                                                |
| `cardo --version` / `-v`           | —                                          | Print CLI version from `package.json`                                                                                                                                                                                                                                                                                                      |
| `cardo --help` / `-h` / no command | —                                          | Print help                                                                                                                                                                                                                                                                                                                                 |

Errors: any thrown error → `cardo: <message>` on stderr, exit `1` (`cli.ts`).

Exported from `install-logic.ts`:

| Export               | Signature                                            | Description                                                                                                                                |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `REPO`               | `string`                                             | `process.env.CARDO_GITHUB_REPO ?? 'Uniterra-Solutions/cardo'`                                                                              |
| `currentPlatform`    | `() => InstallPlatform`                              | `'windows'` on win32, else `'macos'` (the CLI only targets the two)                                                                        |
| `sourceArchiveUrl`   | `(tag: string) => string`                            | GitHub auto-generated tarball URL `https://github.com/<repo>/archive/refs/tags/<tag>.tar.gz`                                               |
| `findSourceRoot`     | `(dir: string) => Promise<string>`                   | Exactly one `cardo-*` dir after extract, else throw                                                                                        |
| `findBuiltApp`       | `(src: string, platform?) => Promise<string>`        | macOS: first `*.app` under any `mac-*` dir; Windows: `win-unpacked/` dir containing an `.exe`; else throw                                  |
| `installDestination` | `(platform, env, appPath) => string`                 | macOS `~/Applications/<basename>`; Windows `%LOCALAPPDATA%\Programs\Cardo` (`~/AppData/Local` fallback)                                    |
| `launchTarget`       | `(platform, destination) => string`                  | The `.app` itself / `Cardo.exe` inside the Windows install dir                                                                             |
| `embedResourcesDir`  | `(platform, appRoot) => string`                      | `Contents/Resources` / `resources` — both are `process.resourcesPath` at runtime                                                           |
| `builderArgs`        | `(platform, version) => readonly string[]`           | `--mac` vs `--win --dir`, plus `--publish never` and the version stamp                                                                     |
| `startMenuShortcut`  | `(exePath, env) => { lnkPath, script }`              | Start Menu `.lnk` path + WScript.Shell PowerShell script (single quotes escaped)                                                           |
| `psSingleQuote`      | `(value: string) => string`                          | `'` → `''` escape for single-quoted PowerShell strings                                                                                     |
| `readVersion`        | `(pkgPath?) => Promise<string>`                      | Regex-read `version` from package.json                                                                                                     |
| `parseArgs`          | `(args: readonly string[]) => ParsedArgs`            | `{ command, open, dryRun, source? }`; `--source <dir>` consumes the next token (missing value throws); PBT-locked                          |
| `installPlan`        | `(command, open, dryRun) => readonly InstallStage[]` | `update` = `update-cli` → `build-install-app` → (`launch-app` iff open); `setup` = the same minus `update-cli`; dry-run = `[]`; PBT-locked |

## Setup / Update Flow

Both commands execute the same stage plan (`installPlan`, PBT-locked); `cardo update` prepends the CLI self-update stage. `runInstallPlan` (`cli.ts`) dispatches the stages; `buildInstallApp` covers steps 2–11:

1. `update-cli` (`cardo update` only, runs FIRST — before the long build, so npm/permission problems surface immediately): `npm install -g @uniterra-solutions/cardo@latest`.
2. Resolve source: `--source <dir>` (validated by `packages/cardo-desktop/package.json`; version read from that package.json) — or fetch latest release (404 → `releases?per_page=1` fallback), download tarball, extract (`/usr/bin/tar` macOS / `tar` from PATH Windows — Win10+ ships bsdtar), locate the `cardo-*` root.
3. `--dry-run` short-circuits here (the plan is empty): `cardo update --dry-run` prints the full update plan and stops — no downloads at all (deterministic/offline); `cardo setup --dry-run` still resolves the source to print its report (no install).
4. `pnpm install --frozen-lockfile` with `CI: 'true'` (pnpm 11 aborts without a TTY).
5. `pnpm run build`.
6. Package: `pnpm exec electron-builder <builderArgs(platform, version)>` in `packages/cardo-desktop`.
7. `findBuiltApp(platform)`: the `.app` under `dist/mac-*` / the `win-unpacked` dir.
8. Move the artifact out of the tree (embedding the source into itself is illegal): `/bin/mv` (macOS, cross-volume safe) / `fs.rename` with EXDEV fallback to `robocopy` + `rm` (Windows — CI workspaces can live on another volume than the temp dir).
9. Embed source: `/bin/cp -R <src> <app>/Contents/Resources/src` / `robocopy /MT:16 <src> <win-unpacked>/resources/src` — the tree the packaged app resolves everything from (multi-threaded: the pnpm store is hundreds of thousands of small files).
10. Install: `/usr/bin/ditto` → `~/Applications/Cardo.app` / same-volume `fs.rename` → `%LOCALAPPDATA%\Programs\Cardo` (tmp and LOCALAPPDATA are both on C:, so the multi-GB move is instant; ANY rename failure — EXDEV cross-volume, EPERM locked files — falls back to `robocopy /MT:16 /R:5 /W:5`), replacing any existing copy.
11. Windows only: Start Menu shortcut via `powershell` WScript.Shell (best-effort — a missing shortcut never fails the install).
12. `launch-app` (unless `--no-open`): `/usr/bin/open` / detached spawn of `Cardo.exe` — after an update this relaunch is the app restart.
13. `finally`: remove the temp root.

Platform notes:

- macOS tools are absolute `/usr/bin` paths; Windows tools (`tar`, `robocopy`, `powershell`) resolve from PATH.
- `robocopy` exit codes 0–7 are success (bitmask); `run()` is bypassed for it — a non-zero code is not a failure. Runs with `/MT:16` (parallel threads) and is only the copy engine when a same-volume rename is impossible.
- `run()` on Windows uses `shell: true` (args quoted for cmd.exe via `cmdQuote`): npm/pnpm/cardo ship as `.cmd` shims that execFile cannot launch directly (`spawn ENOENT`); cmd.exe resolves them via PATHEXT. `.exe` tools (`tar`, `robocopy`, `powershell`) would resolve either way.
- `.app` discovery accepts any `mac-*` dir (host arch chosen by electron-builder `[INFERRED]`); Windows expects `win-unpacked/` with an `.exe` (any name).

## Decisions

| Decision                                                                   | Rationale                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Source is the artifact — download + build on the user's machine            | Matches the repo exactly; one flow, platform branches for the OS steps                     |
| Windows ships `win-unpacked/` (`--win --dir`), not NSIS                    | The source is embedded AFTER packaging; an installer image can't carry it                  |
| Windows installs per-user under `%LOCALAPPDATA%\Programs\Cardo`            | No elevation needed; mirrors `~/Applications`                                              |
| Start Menu shortcut is best-effort                                         | A missing shortcut must never fail the install                                             |
| `--source <dir>` local checkout mode                                       | Windows CI verifies the REAL CLI end-to-end without downloading a release                  |
| `cardo update` = CLI self-update + full rebuild + relaunch (one command)   | The desktop's Update Now quits and runs exactly this — no separate `cardo setup` for users |
| `cardo update` refreshes the CLI FIRST                                     | npm/permission problems fail fast, before the multi-minute build                           |
| `CI=true` injected into pnpm install                                       | pnpm 11 aborts without a TTY                                                               |
| `/releases/latest` 404 → fall back to `releases?per_page=1`                | `/releases/latest` excludes prereleases; beta tags must still install                      |
| `CARDO_GITHUB_REPO` env override                                           | Point the installer at a fork/mirror in tests                                              |
| Version stamp: release tag without `v`; `--source`: source desktop version | Align app metadata with the release tag                                                    |

## Dependencies

- Outbound: node builtins (`fs`, `child_process`, `stream`), platform tools (macOS `/usr/bin/*`; Windows `tar`/`robocopy`/`powershell`), GitHub API, npm registry.
- Inbound: none in-repo (leaf package; the desktop does NOT import it).

## Patterns & Gotchas

- macOS subprocesses use absolute `/usr/bin` paths — never rely on PATH there; Windows resolves tools from PATH (`.exe` directly, `.cmd` shims through `shell: true` + PATHEXT).
- PBT (`test/pbt.test.mts`) locks arg parsing (`--source` consumption included), the `installPlan` stage order (`update` = CLI refresh → rebuild → relaunch; `setup` never touches the CLI; dry-run runs nothing), `.app` + `win-unpacked` discovery, install destinations, builder args, and shortcut script quoting.
- `prepack` runs `pnpm run build` so npm ships a freshly compiled `dist/`.

## How to Update

- New command/flag → update the Public API table + `parseArgs` PBT.
- Install steps change → update the Setup Flow list, run `scripts/verify-cli-container/run.sh` (Linux container), and re-run `scripts/verify-windows-install/verify.ps1` via the release gate (windows-latest).

## Find It Fast

```bash
grep -n 'export function' packages/cardo-cli/src/install-logic.ts  # public helpers
grep -n 'case ' packages/cardo-cli/src/cli.ts                      # command dispatch
```
