# Setup

Two paths: end-user install (the `uniterra` CLI) and developer setup (this monorepo).

## End-User Install (macOS / Windows 10+)

```bash
npm install -g @uniterra-solutions/uniterra
uniterra setup            # download source → build → package → install → launch
```

Install targets: macOS `~/Applications/Uniterra.app`; Windows `%LOCALAPPDATA%\Programs\Uniterra` (plus a Start Menu shortcut). Prerequisites on both platforms: Node ≥ 22, pnpm, git; Windows 10+ ships `tar` built in.

`uniterra setup` flags: `--source <dir>` (build a local workspace checkout instead of downloading a release), `--move-source` (treat the `--source` checkout as disposable and move it into the app instead of copying — throwaway checkouts only, e.g. CI verification; the checkout must not be a working copy you want to keep), `--no-open` (skip launch), `--dry-run` (print the plan, install nothing). Re-running `uniterra setup` reinstalls the app. `uniterra update` is the one-command update: it refreshes the CLI itself, then rebuilds + reinstalls the app from the latest source and relaunches it (same flags as `setup`; `--no-open` skips the relaunch). The desktop's Update Now quits the app and runs `uniterra update` automatically — the relaunch IS the restart. See [modules/uniterra-cli.md](modules/uniterra-cli.md).

## Developer Setup

Prerequisites:

| Tool    | Version                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------- |
| Node.js | ≥ 22 (`.nvmrc`)                                                                                       |
| pnpm    | 11.17.0 (enable via corepack or install globally)                                                     |
| Docker  | optional — only for `scripts/verify-cli-container/run.sh`                                             |
| OS      | macOS (for `electron .` and electron-builder `--mac`) or Windows 10+ (electron-builder `--win --dir`) |

```bash
git clone https://github.com/Uniterra-Solutions/uniterra.git
cd uniterra
pnpm install --frozen-lockfile   # installs workspace deps + husky hooks
pnpm build                       # tsc -b + skills copy + provider bundle
pnpm typecheck                   # tsc -b --noEmit
pnpm lint                        # eslint . (strictTypeChecked, max-warnings 0)
```

Run the desktop in dev (never touches the real `~/.dsh` — uses a mirrored test home):

```bash
pnpm --filter @uniterra-solutions/uniterra-desktop dev
```

## Environment Variables

| Var                             | Default                       | Used by                         | Notes                                                        |
| ------------------------------- | ----------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `UNITERRA_GITHUB_REPO`          | `Uniterra-Solutions/uniterra` | uniterra-cli                    | Point the installer at a fork/mirror                         |
| `UNITERRA_BUILD_VERSION`        | —                             | uniterra-desktop package script | Override electron-builder version                            |
| `UNITERRA_BASE_URL`             | provider default              | uniterra-provider               | Gateway base URL fallback (trusted layers only)              |
| `UNITERRA_UPDATE_API_BASE`      | GitHub API                    | uniterra-desktop                | Update-probe endpoint override                               |
| `UNITERRA_UPDATE_NPM_URL`       | npm registry                  | uniterra-desktop                | CLI dist-tag probe override                                  |
| `UNITERRA_UPDATE_COMMAND`       | `uniterra --version`          | uniterra-desktop                | Installed-CLI version probe                                  |
| `UNITERRA_UPDATE_RELEASES_PAGE` | GitHub                        | uniterra-desktop                | Release page shown in the prompt                             |
| `UNITERRA_UPDATE_DELAY_MS`      | 5000                          | uniterra-desktop                | Startup delay before the update check                        |
| `DSH_HOME`                      | `~/.dsh`                      | dsh runtime                     | dsh home; dev uses the mirrored test home instead            |
| `DSH_BUNDLED_SKILL_DIR`         | —                             | dsh runtime                     | Set by the app to the bundled skills dir                     |
| `PI_CODING_AGENT_DIR`           | `~/.pi/agent`                 | uniterra-skills                 | Agent skills dir for pi-agent provisioning                   |
| `ELECTRON_RUN_AS_NODE`          | —                             | uniterra-desktop                | Internal: Electron binary runs as plain Node                 |
| `UNITERRA_SOURCE_ROOT`          | repo root                     | scripts/verify-cli-container    | Source root the container PBT suite loads built modules from |

## Verify

```bash
pnpm run build && pnpm run lint && pnpm run typecheck      # static gates
pnpm --filter @uniterra-solutions/uniterra-desktop test                     # boot + builtins/readiness PBT
pnpm --filter @uniterra-solutions/uniterra-provider test                    # composition + wire invariants
pnpm --filter @uniterra-solutions/uniterra test                # CLI + install-logic PBT
pnpm --filter @uniterra-solutions/uniterra-skills test                      # provisioning idempotency
pnpm --filter @uniterra-solutions/uniterra-systemprompt test                # rule injection
scripts/verify-cli-container/run.sh                         # clean-container installer replay (Docker)
scripts/verify-windows-install/verify.ps1                    # real Windows install + boot smoke (CI: windows-latest, release gate)
```

Test details: [testing.md](testing.md).

## How to Update

- Install/run commands change → update this file and the root README's commands (one home per fact: commands live here; the README links).
- New env var → add a row to the table.
- Installer flow changes → also run `scripts/verify-cli-container/run.sh` (and the Windows gate runs on release).

## Find It Fast

```bash
grep -rn 'UNITERRA_' packages/*/src scripts/ --include='*.ts' --include='*.mjs' # env surface
```
