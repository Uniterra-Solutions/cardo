# Module: Built-in Plugins (vendor/dsh-plugins + npm built-ins)

**Purpose:** The plugin surface that ships with Cardo — 10 npm-published community plugins, 5 vendored community plugins pinned at fixed commits, and 1 in-house workspace plugin. All are ensured into the user's dsh `web` profile at startup (`packages/cardo-desktop/src/builtin.ts`).

## Built-in Lists

### npm built-ins (`BUILTIN_NPM_PLUGINS`)

Pinned exact, installed via `dsh plugin add`:

| Spec                            | Purpose                      |
| ------------------------------- | ---------------------------- |
| dshmarket@1.9.0                 | Plugin marketplace           |
| dsh-notifier@0.6.2              | Push notifications           |
| dsh-better-sidebar@0.12.2       | Sidebar enhancement          |
| dsh-file-upload@0.4.2           | File upload                  |
| dsh-find-plugin@0.3.6           | Plugin discovery             |
| dsh-subagent-model-picker@0.1.1 | Per-subagent model selection |
| dsh-hotkeys@0.1.1               | Keyboard shortcuts           |
| dsh-tool-git@0.1.3              | Git tools for agents         |
| dsh-browser-playwright@0.1.1    | Browser automation           |
| dsh-computer-use@0.1.0          | Computer use                 |

### Vendored built-ins (`BUILTIN_VENDOR_PLUGINS`)

Vendored at pinned commits because they are not published to npm — `dsh plugin add github:<repo>` would install the default branch HEAD with no version lock. Copied into the profile's `node_modules` under their package name (NOT pnpm-installed — they declare peers that only exist in the dsh source workspace).

| Dir                    | Package name                                  | Pinned commit | Purpose                                                                                                                    |
| ---------------------- | --------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dsh-deep-whale`       | @dsh-external/dsh-client-ui-skin-maid-atelier | `873f5c6…`    | Whale-maid UI skin (standalone distribution; self-inserting patch, no-op host, art embedded as data URIs). CC BY-NC-SA 4.0 |
| `dsh-subagent-monitor` | @leetoners/dsh-ui-subagent-monitor            | `5f7f026…`    | Live subagent run monitor                                                                                                  |
| `dsh-thinking-effort`  | dsh-thinking-effort                           | `b2f5c54…`    | Reasoning-effort level editor for third-party models                                                                       |
| `dsh-shortcuts`        | dsh-shortcuts                                 | `0d12280…`    | 34 keyboard shortcuts, one-click recording, macOS-first                                                                    |
| `dsh-git-graph`        | dsh-git-graph                                 | `6b98990…`    | Embedded git repo graph visualizer (zero npm deps; serves its own `web/`)                                                  |

The retired `deep-whale-day-night-theme` distribution is documented in `vendor/dsh-plugins/VENDOR.md` (it depended on `dsh-client-ui-theme-plugins` / `dsh-host-theme-catalog`, absent in the pinned rc.6 family, so its patch silently no-oped).

### Workspace built-in (`BUILTIN_WORKSPACE_PLUGINS`)

| Source dir                | Package name          |
| ------------------------- | --------------------- |
| `packages/cardo-provider` | @cardo/cardo-provider |

Ships pre-built (self-contained host bundle, runtime deps inlined) — copied with `package.json` + `lib/` + `cordis.patch.yml`, no pnpm install. See [cardo-provider.md](cardo-provider.md).

## Provisioning Semantics

`ensureBuiltinPlugins(dshHome, profile, dshCli, nodeExec, vendorRoot, sourceRoot)` (`builtin.ts:193-266`):

1. No-op when the profile dir is missing (never scaffolds) or when `hasAllBuiltins` AND no vendored/workspace copy is stale.
2. Write `pnpm-workspace.yaml` (allowBuilds for native deps: node-pty, sharp, protobufjs, fsevents, tesseract.js; `minimumReleaseAge: 0`).
3. `dsh plugin add` each npm spec (env: `DSH_HOME`, `ELECTRON_RUN_AS_NODE=1`).
4. Copy each vendored + workspace built-in into `node_modules/<pkg-name>` and append its bundle row to the profile `package.json` `dsh.profile.bundles`.
5. Expected bundle rows: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, + every built-in package name.

Staleness (re-provision trigger): installed copy's `package.json` `version` ≠ source `version`, or unreadable — content identity, not bundle-list (a fixed distribution can ship under the same package name). This heals existing profiles on their next launch after a built-in swap.

## Update Policy (bumping a vendored plugin)

Per `vendor/dsh-plugins/VENDOR.md`:

1. `git -C vendor/dsh-plugins/<name> fetch --depth 1 origin`; checkout the new commit.
2. Verify it still targets the cardo-pinned dsh family (0.1.0-rc.6 / cordis 4.0.1); re-run the smoke test.
3. Update the pin-ledger row in `VENDOR.md`.

Smoke test: sandbox `DSH_HOME`, boot the profile, expect HTTP 200 on the web port with no load error mentioning the plugins.

## Gotchas

- Never hand-edit `vendor/dsh-plugins/` contents — bump via the update policy (AGENTS.md prohibition).
- `vendor/dsh-runtime/` is a legacy 0.5.0 snapshot (its manifest still references the retired `deep-whale-day-night-theme`); the current boot path resolves the dsh CLI from `packages/cardo-desktop/node_modules` — see [cardo-desktop.md](cardo-desktop.md).
- The root `pnpm-workspace.yaml` `minimumReleaseAgeExclude` mirrors the npm built-in set — keep the two lists in sync when adding npm built-ins.

## How to Update

- npm built-in added/removed → edit `BUILTIN_NPM_PLUGINS`, extend `builtin-pbt.test.mjs`, update the root `pnpm-workspace.yaml` `minimumReleaseAgeExclude`.
- Vendored plugin added → vendor it, add a `BUILTIN_VENDOR_PLUGINS` row, update `VENDOR.md` + this table.
- Workspace plugin added → add a `BUILTIN_WORKSPACE_PLUGINS` row; ensure its build produces a self-contained bundle.

## Find It Fast

```bash
grep -n 'BUILTIN_' packages/cardo-desktop/src/builtin.ts   # the three lists
cat vendor/dsh-plugins/VENDOR.md                            # pin ledger + update policy
```
