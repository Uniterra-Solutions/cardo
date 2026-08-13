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

No environment variables are required. The extension reads pi's standard agent dir (`~/.pi/agent/`):

| Variable / File             | Purpose                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `~/.pi/agent/jovaltus.json` | Pipeline state (written by the extension)                                                      |
| `~/.pi/agent/auth.json`     | Model auth — **must be configured** for pi to run (the extension's child processes inherit it) |

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
```

After install, `/reload` (or restart pi). The four tools (`plan`/`execute`/`simplify`/`review`) appear in the tool list.

## Verify

1. `pi -e packages/jovaltus/src/index.ts` starts without a "factory function" error.
2. `pi install ./packages/jovaltus` then `pi list` shows the package.
3. In a session, the tool list includes `plan`/`execute`/`simplify`/`review`.
4. Optional smoke: run `plan` with a small requirement; confirm `.plan/<date>/<name>/prd.md` appears and `~/.pi/agent/jovaltus.json` holds a `pipeline` key while running.

## How to Update

- Install/run command changed → update the Run + Verify sections.
- New env var / config file → add to the Environment table.
