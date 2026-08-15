# Setup

## Prerequisites

| Tool    | Version | Notes                                                                         |
| ------- | ------- | ----------------------------------------------------------------------------- |
| Node.js | >= 22   | `.nvmrc` / `engines`                                                          |
| pnpm    | 11.x    | `corepack` or npm global                                                      |
| pi CLI  | >= 0.84 | `@earendil-works/pi-coding-agent`; extension targets the installed pi version |

## Install

```bash
pnpm install        # installs all workspace deps (runs husky prepare)
```

Never run `pnpm install` without `--frozen-lockfile` in CI.

## Environment Configuration

No environment variables are required for the CLI extension. It reads pi's standard agent dir (`~/.pi/agent/`):

| Variable / File               | Purpose                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/jovaltus.sqlite` | Session store — one row per pipeline run (`running`/`done`/`failed`/`interrupted`); read it via `list_sessions`                                                                                            |
| `~/.pi/agent/auth.json`       | Model auth — **must be configured** for pi to run (the extension's child processes inherit it)                                                                                                             |
| `PI_CLI_PATH`                 | Optional. Absolute path to a pi CLI entry (`.js` → run under current runtime with `ELECTRON_RUN_AS_NODE`; otherwise executed directly). The desktop app sets it automatically to the bundled `dist/cli.js` |

Login pi to a provider before using the pipeline tools: `pi` → `/login` (or set a provider key). Without auth, child phase processes fail with exit ≠ 0.

## Run

```bash
# Dev gates (repo root)
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build

# Load the extension in a pi session (one-off, no install)
pi -e packages/jovaltus/src/index.ts

# Install as a pi package
pi install ./packages/jovaltus

# Or manual copy (global)
mkdir -p ~/.pi/agent/extensions
cp -r packages/jovaltus ~/.pi/agent/extensions/jovaltus

# Desktop app (vendored pi-gui) — jovaltus is a built-in extension
pnpm --filter @pi-gui/desktop dev          # dev (Electron + watch)
pnpm --filter @pi-gui/desktop build        # production build (out/)
```

After install, `/reload` (or restart pi). The six tools (`plan`/`execute_plan`/`simplify`/`review`/`list_sessions`/`resume_session`) are registered — `plan` and `execute_plan` appear in the tool list once plan mode is on (`/planmode`, TUI shift+P, or desktop shift+tab / mode button). In the desktop app they are available without any install step — pick **plan** on the new-thread page's mode selector (standard/plan) to start the conversation in plan mode, or toggle plan mode in the composer of an existing thread, and the agent can call them.

## Verify

1. `pi -e packages/jovaltus/src/index.ts` starts without a "factory function" error.
2. `pi install ./packages/jovaltus` then `pi list` shows the package.
3. In a session, the tool list includes `plan`/`execute_plan`/`simplify`/`review`/`list_sessions`/`resume_session`.
4. Optional smoke: run `plan` with a small requirement; confirm `.plan/<date>/<name>/prd.md` appears and `list_sessions` shows the run (or inspect `~/.pi/agent/jovaltus.sqlite`).
5. Desktop: `pnpm --filter @pi-gui/desktop dev` opens the app; Settings → Extensions lists two built-ins ("Thread orchestration" + "Jovaltus"); a thread can run the `plan` tool end-to-end.

## Packaging / macOS signing

- Local dev (`pnpm ... dev` or running the built app on the same machine) needs no signing.
- Distributing the `.dmg` to other machines requires an Apple Developer ID certificate + notarization (Apple Developer Program, $99/year). The vendored `electron-builder.yml` already sets `hardenedRuntime` + `notarize`; supply `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` at package time.
- Without credentials, ship an unsigned `.dmg` for internal testing (users right-click → Open once) or distribute via Homebrew cask / MDM.
- Before distributing, change the vendored `appId` / `productName` / `copyright` (currently pi-gui's) to the company's.

## Distribution (npm CLI + GitHub Releases)

Users install with one command:

```bash
npm install -g @uniterra-solutions/cardo
cardo setup        # downloads the latest macOS app zip from GitHub Releases → ~/Applications
cardo update       # updates the CLI, then reinstalls the latest app
```

How it works:

- `.github/workflows/release.yml` runs on `v*` tag pushes (plus a `workflow_dispatch` recovery input). The CLI package is published to npm via **trusted publishing** (OIDC — no tokens in the repo), and the macOS app is built unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`) on a macOS runner and attached to a GitHub Release (zip + dmg).
- No Apple Developer signing/notarization is involved. The CLI downloads the zip over HTTPS with Node's `fetch`, so no `com.apple.quarantine` attribute is set and Gatekeeper never checks the app.
- The CLI matches `-arm64.zip` / `-x64.zip` assets by the host architecture and installs the `.app` bundle it finds into `~/Applications` (no admin rights needed). macOS only.
- The desktop job depends on the npm publish job, so the GitHub Release is created only after the CLI is published.

One-time setup (npm trusted publishing):

1. `npm login` with an account that has publish rights on the `@uniterra-solutions` scope.
2. First manual publish to create the package (local npm has no OIDC, so no `--provenance`):
   `cd packages/cli && npm publish --access public`
3. npmjs.com → `@uniterra-solutions/cardo` → Settings → Trusted Publishing → **Add publisher**: GitHub, repository `Uniterra-Solutions/cardo`, workflow `release.yml` (environment left blank; optionally restrict ref to `refs/tags/v*`). From here on, CI publishes with `npm publish --provenance`. The workflow checks npm first and **skips the publish when the version already exists** (e.g. a manually published version can still get its GitHub Release).
4. Make the GitHub repo public (the CLI's latest-release lookup uses the unauthenticated GitHub API).
5. First release: bump `packages/cli/package.json` version to `x.y.z`, tag `vx.y.z`, push the tag individually (`git push origin v0.1.0`), then confirm with `gh run list --workflow=release.yml`.

Notes:

- The app bundle inside the release zip currently keeps the vendored `productName` (e.g. `pi-gui.app`); the CLI installs whatever `.app` it finds.
- arm64-only builds until an x64 target is added to the electron-builder config (the CLI already supports both, but only arm64 assets are produced today).
- No GitHub secrets are needed at all: npm uses OIDC trusted publishing and the app build is unsigned.

## How to Update

- Install/run command changed → update the Run + Verify sections.
- New env var / config file → add to the Environment table.
