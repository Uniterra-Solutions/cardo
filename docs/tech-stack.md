# Tech Stack

All versions are the spec ranges from `package.json` / `pnpm-workspace.yaml`; the lockfile (`pnpm-lock.yaml`) is authoritative for installs.

## Runtime

| Component           | Version                      | Purpose                                                                         |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Node.js             | ≥ 22 (`.nvmrc`: 22)          | All packages; electron-builder packaging                                        |
| pnpm                | 11.17.0 (`packageManager`)   | Workspace + profile plugin installs (`allowBuilds` / `minimumReleaseAge` gates) |
| Electron            | ^37.10.3                     | Desktop shell (main process) hosting the dsh Web UI                             |
| @deepseek-ai/dsh    | 0.1.0-rc.6 (exact, no caret) | DeepSeek Harness agent runtime — bundled CLI + web app                          |
| @deepseek-ai/cordis | 4.0.1 (exact)                | dsh plugin/service container                                                    |
| React               | ^18.2.0                      | Client-side settings UI of `@cardo/cardo-provider`                              |

## Language / Module System

| Component  | Version  | Notes                                                                  |
| ---------- | -------- | ---------------------------------------------------------------------- |
| TypeScript | ~5.9.0   | Every package; `tsc -b` project references                             |
| ESM        | NodeNext | `"type": "module"` everywhere; internal imports require `.js` suffixes |

## Workspace Packages

| Package                   | Version | Purpose                                                        |
| ------------------------- | ------- | -------------------------------------------------------------- |
| @cardo/cardo-desktop      | 0.8.0   | Electron shell over the bundled dsh CLI; built-in provisioning |
| @uniterra-solutions/cardo | 0.8.0   | Public npm installer CLI (bin `cardo`)                         |
| @cardo/cardo-provider     | 0.1.1   | In-house dual-protocol LLM provider plugin                     |
| @cardo/cardo-skills       | 0.5.0   | Built-in skill registry (10 company skills)                    |
| @cardo/cardo-systemprompt | 0.5.0   | pi-agent extension: app-wide working rules                     |
| @cardo/cardo-updater      | 0.5.0   | Update decision + action mapping (pure, no Electron)           |

## dsh Client Peer Packages (cardo-provider)

All pinned exact at 0.1.0-rc.6 — see `packages/cardo-provider/package.json` `peerDependencies`:

`@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-ui-slots` (dev), `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-launch-environment`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-timeout`, plus `@deepseek-ai/schemastery` ^3.18.1.

## Third-Party Libraries

| Library                         | Version | Used By            | Purpose                                                |
| ------------------------------- | ------- | ------------------ | ------------------------------------------------------ |
| eventsource-parser              | ^3.1.0  | cardo-provider     | SSE stream parsing                                     |
| undici                          | ^7      | cardo-provider     | HTTP client for upstream gateways                      |
| @earendil-works/pi-coding-agent | ^0.84.1 | cardo-systemprompt | pi-agent extension runtime (`before_agent_start` hook) |

## Tooling

| Tool             | Version                             | Purpose                                                                                        |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| esbuild          | ^0.25.0                             | cardo-provider host/client bundling (deps inlined, peers external)                             |
| electron-builder | ^25.1.8                             | Packaging: `--mac` → `Cardo.app` / `--win --dir` → `win-unpacked` (source embedded afterwards) |
| ESLint           | ^9.34.0 + typescript-eslint ^8.46.0 | `strictTypeChecked` + extra strict rules                                                       |
| Prettier         | ^3.6.2                              | Formatting (single quotes, trailing commas, width 100, LF)                                     |
| husky            | ^9.1.7                              | Pre-commit hook (`prepare` tolerates missing `.git` in source tarballs)                        |
| lint-staged      | ^16.1.2                             | `prettier --write` + `eslint --fix --max-warnings 0` on staged files                           |

## Testing

| Tool       | Version            | Purpose                                                                                              |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| node:test  | built-in (Node 22) | All test suites                                                                                      |
| fast-check | ^4.9.0             | Property-based tests (desktop built-ins, CLI install logic, updater decision, provider wire shapes)  |
| Docker     | —                  | `scripts/verify-cli-container` clean-room CLI-flow replay (optional, no macOS runner needed)         |
| Windows CI | —                  | `scripts/verify-windows-install/verify.ps1` on windows-latest: real install + `Cardo.exe` boot smoke |

## Built-in dsh Plugins

Provisioned into the user's dsh profile at startup — see [modules/vendor-plugins.md](modules/vendor-plugins.md) and `packages/cardo-desktop/src/builtin.ts`.

| Source                           | Plugins                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm (pinned exact)               | dshmarket 1.9.0, dsh-notifier 0.6.2, dsh-better-sidebar 0.12.2, dsh-file-upload 0.4.2, dsh-find-plugin 0.3.6, dsh-subagent-model-picker 0.1.1, dsh-tool-git 0.1.3, dsh-browser-playwright 0.1.1, dsh-computer-use 0.1.0 |
| vendored (`vendor/dsh-plugins/`) | dsh-deep-whale (skin), dsh-shortcuts                                                                                                                                                                                    |
| workspace built-in               | @cardo/cardo-provider                                                                                                                                                                                                   |

## External Services

| Service               | Used By                                        | Purpose                                                                   |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| npm registry          | cardo-cli publish, `dsh plugin add`, dshmarket | Installer distribution + plugin installs                                  |
| GitHub Releases       | cardo-cli, cardo-updater                       | Source-archive artifact (`cardo setup`), `releases/latest` update probe   |
| models.dev API        | cardo-provider                                 | Context-window / output-token / reasoning-effort auto-detection per model |
| Upstream LLM gateways | cardo-provider                                 | Any OpenAI-compatible endpoint (chat completions and/or Responses API)    |

## CI/CD

| System                         | Purpose                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions (`ci.yml`)      | Every PR: parallel lint / typecheck / tests (also callable from the release workflow)                                                                                                                                                   |
| GitHub Actions (`release.yml`) | On `v*` tag: publish is gated on ci + clean-container installer replay + windows-latest install verification (all via `needs`); then npm trusted publishing (OIDC) of the CLI → GitHub Release (source archive is the desktop artifact) |

## How to Update

- Dependency added/removed/upgraded → update the corresponding table (keep exact pins for `@deepseek-ai/*`).
- New built-in plugin → update the Built-in dsh Plugins table and `vendor/dsh-plugins/VENDOR.md`.
- Node/Electron/pnpm bump → update here, `.nvmrc`, and `engines`.

## Find It Fast

```bash
grep -h '"@deepseek-ai/dsh"\|"electron"' packages/*/package.json    # pinned runtime versions
grep -n 'BUILTIN_NPM_PLUGINS' packages/cardo-desktop/src/builtin.ts # npm built-in list
```
