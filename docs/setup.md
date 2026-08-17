# Setup

Two paths: end-user install (the `cardo` CLI) and developer setup (this monorepo).

## End-User Install (macOS / Windows 10+)

```bash
npm install -g @uniterra-solutions/cardo
cardo setup            # download source → build → package → install → launch
```

Install targets: macOS `~/Applications/Cardo.app`; Windows `%LOCALAPPDATA%\Programs\Cardo` (plus a Start Menu shortcut). Prerequisites on both platforms: Node ≥ 22, pnpm, git; Windows 10+ ships `tar` built in.

`cardo setup` flags: `--source <dir>` (build a local workspace checkout instead of downloading a release), `--no-open` (skip launch), `--dry-run` (print the plan, install nothing). Re-running `cardo setup` reinstalls the app. `cardo update` is the one-command update: it refreshes the CLI itself, then rebuilds + reinstalls the app from the latest source and relaunches it (same flags as `setup`; `--no-open` skips the relaunch). The desktop's Update Now quits the app and runs `cardo update` automatically — the relaunch IS the restart. See [modules/cardo-cli.md](modules/cardo-cli.md).

## Developer Setup

Prerequisites:

| Tool    | Version                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------- |
| Node.js | ≥ 22 (`.nvmrc`)                                                                                       |
| pnpm    | 11.17.0 (enable via corepack or install globally)                                                     |
| Docker  | optional — only for `scripts/verify-cli-container/run.sh`                                             |
| OS      | macOS (for `electron .` and electron-builder `--mac`) or Windows 10+ (electron-builder `--win --dir`) |

```bash
git clone https://github.com/Uniterra-Solutions/cardo.git
cd cardo
pnpm install --frozen-lockfile   # installs workspace deps + husky hooks
pnpm build                       # tsc -b + skills copy + provider bundle
pnpm typecheck                   # tsc -b --noEmit
pnpm lint                        # eslint . (strictTypeChecked, max-warnings 0)
```

Run the desktop in dev (never touches the real `~/.dsh` — uses a mirrored test home):

```bash
pnpm --filter @cardo/cardo-desktop dev
```

## Environment Variables

| Var                          | Default                    | Used by                      | Notes                                                        |
| ---------------------------- | -------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `CARDO_GITHUB_REPO`          | `Uniterra-Solutions/cardo` | cardo-cli                    | Point the installer at a fork/mirror                         |
| `CARDO_BUILD_VERSION`        | —                          | cardo-desktop package script | Override electron-builder version                            |
| `CARDO_BASE_URL`             | provider default           | cardo-provider               | Gateway base URL fallback (trusted layers only)              |
| `CARDO_UPDATE_API_BASE`      | GitHub API                 | cardo-desktop                | Update-probe endpoint override                               |
| `CARDO_UPDATE_NPM_URL`       | npm registry               | cardo-desktop                | CLI dist-tag probe override                                  |
| `CARDO_UPDATE_COMMAND`       | `cardo --version`          | cardo-desktop                | Installed-CLI version probe                                  |
| `CARDO_UPDATE_RELEASES_PAGE` | GitHub                     | cardo-desktop                | Release page shown in the prompt                             |
| `CARDO_UPDATE_DELAY_MS`      | 5000                       | cardo-desktop                | Startup delay before the update check                        |
| `DSH_HOME`                   | `~/.dsh`                   | dsh runtime                  | dsh home; dev uses the mirrored test home instead            |
| `DSH_BUNDLED_SKILL_DIR`      | —                          | dsh runtime                  | Set by the app to the bundled skills dir                     |
| `PI_CODING_AGENT_DIR`        | `~/.pi/agent`              | cardo-skills                 | Agent skills dir for pi-agent provisioning                   |
| `ELECTRON_RUN_AS_NODE`       | —                          | cardo-desktop                | Internal: Electron binary runs as plain Node                 |
| `CARDO_SOURCE_ROOT`          | repo root                  | scripts/verify-cli-container | Source root the container PBT suite loads built modules from |

## Verify

```bash
pnpm run build && pnpm run lint && pnpm run typecheck      # static gates
pnpm --filter @cardo/cardo-desktop test                     # boot + builtins/readiness PBT
pnpm --filter @cardo/cardo-provider test                    # composition + wire invariants
pnpm --filter @uniterra-solutions/cardo test                # CLI + install-logic PBT
pnpm --filter @cardo/cardo-skills test                      # provisioning idempotency
pnpm --filter @cardo/cardo-systemprompt test                # rule injection
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
grep -rn 'CARDO_' packages/*/src scripts/ --include='*.ts' --include='*.mjs' # env surface
```
