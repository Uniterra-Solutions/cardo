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

| Variable / File             | Purpose                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/jovaltus.json` | Pipeline state (written by the extension)                                                                                                                                                                  |
| `~/.pi/agent/auth.json`     | Model auth — **must be configured** for pi to run (the extension's child processes inherit it)                                                                                                             |
| `PI_CLI_PATH`               | Optional. Absolute path to a pi CLI entry (`.js` → run under current runtime with `ELECTRON_RUN_AS_NODE`; otherwise executed directly). The desktop app sets it automatically to the bundled `dist/cli.js` |

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

After install, `/reload` (or restart pi). The four tools (`plan`/`execute`/`simplify`/`review`) appear in the tool list. In the desktop app they are available without any install step — open a thread and the agent can call them.

## Verify

1. `pi -e packages/jovaltus/src/index.ts` starts without a "factory function" error.
2. `pi install ./packages/jovaltus` then `pi list` shows the package.
3. In a session, the tool list includes `plan`/`execute`/`simplify`/`review`.
4. Optional smoke: run `plan` with a small requirement; confirm `.plan/<date>/<name>/prd.md` appears and `~/.pi/agent/jovaltus.json` holds a `pipeline` key while running.
5. Desktop: `pnpm --filter @pi-gui/desktop dev` opens the app; Settings → Extensions lists two built-ins ("Thread orchestration" + "Jovaltus"); a thread can run the `plan` tool end-to-end.

## Packaging / macOS signing

- Local dev (`pnpm ... dev` or running the built app on the same machine) needs no signing.
- Distributing the `.dmg` to other machines requires an Apple Developer ID certificate + notarization (Apple Developer Program, $99/year). The vendored `electron-builder.yml` already sets `hardenedRuntime` + `notarize`; supply `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` at package time.
- Without credentials, ship an unsigned `.dmg` for internal testing (users right-click → Open once) or distribute via Homebrew cask / MDM.
- Before distributing, change the vendored `appId` / `productName` / `copyright` (currently pi-gui's) to the company's.

## How to Update

- Install/run command changed → update the Run + Verify sections.
- New env var / config file → add to the Environment table.
