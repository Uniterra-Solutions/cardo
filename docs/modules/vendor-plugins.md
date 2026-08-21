# Module: Built-in Plugins (vendor/dsh-plugins + npm built-ins)

**Purpose:** The plugin surface that ships with Uniterra — 9 npm-published community plugins, 1 vendored community plugin pinned at a fixed commit, 1 optional vendored plugin (the Deep Whale skin — shipped but NOT forced, enabled per-profile via a `.uniterra.json` toggle), and 1 in-house workspace plugin. Active ones are ensured into the user's dsh `web` profile at startup (`packages/uniterra-desktop/src/builtin.ts`).

## Built-in Lists

### npm built-ins (`kind: 'npm'`)

Pinned exact, installed via `dsh plugin add` — declared with `registerBuiltinPlugin({ kind: 'npm', spec })`, read by `npmBuiltinSpecs()`:

| Spec                            | Purpose                      |
| ------------------------------- | ---------------------------- |
| dshmarket@1.9.0                 | Plugin marketplace           |
| dsh-notifier@0.6.2              | Push notifications           |
| dsh-better-sidebar@0.12.2       | Sidebar enhancement          |
| dsh-file-upload@0.4.2           | File upload                  |
| dsh-find-plugin@0.3.6           | Plugin discovery             |
| dsh-subagent-model-picker@0.1.1 | Per-subagent model selection |
| dsh-tool-git@0.1.3              | Git tools for agents         |
| dsh-browser-playwright@0.1.1    | Browser automation           |
| dsh-computer-use@0.1.0          | Computer use                 |

### Vendored built-in (`kind: 'vendor'`)

Pinned at a fixed commit because it is not published to npm — `dsh plugin add github:<repo>` would install the default branch HEAD with no version lock. Copied into the profile's `node_modules` under its package name (NOT pnpm-installed — it declares peers that only exist in the dsh source workspace). Declared with `registerBuiltinPlugin({ kind: 'vendor', dir, package })`, read by `copyBuiltins('vendor')`.

| Dir             | Package name  | Pinned commit | Purpose                                                 |
| --------------- | ------------- | ------------- | ------------------------------------------------------- |
| `dsh-shortcuts` | dsh-shortcuts | `0d12280…`    | 34 keyboard shortcuts, one-click recording, macOS-first |

### Optional built-in (`kind: 'optional'`)

Shipped but NOT forced (the Deep Whale skin — a cosmetic theme, CC BY-NC-SA 4.0, non-commercial). Declared with `registerBuiltinPlugin({ kind: 'optional', dir, package })`, read by `copyBuiltins('optional')` and enforced at every boot by `reconcileOptionalPlugins()`. The per-profile `.uniterra.json` toggle file is the source of truth (`OPTIONAL_PLUGINS_FILE`): `optionalPlugins.<package>: true` enables it.

| Dir              | Package name                                  | Pinned commit | Purpose                                                                                                                    |
| ---------------- | --------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dsh-deep-whale` | @dsh-external/dsh-client-ui-skin-maid-atelier | `873f5c6…`    | Whale-maid UI skin (standalone distribution; self-inserting patch, no-op host, art embedded as data URIs). CC BY-NC-SA 4.0 |

Reconcile semantics (`reconcileOptionalPlugins` runs BEFORE the provisioning gate, so an already-full profile still gets its optional state applied):

- Fresh installs never get the skin — optional entries are excluded from `expectedBuiltinBundles()` and from `copyBuiltinsStale()` (a disabled optional has no copy, and must not force a re-provision on every boot).
- Existing row-bearing profiles migrate: a present bundle row is preserved and persisted as enabled (the toggle file is written); nothing is deleted.
- Enabled ⇒ bundle row + fresh copy ensured (copy, not pnpm link — survives app moves, self-heals to the shipped source version); disabled ⇒ row and installed copy removed, idempotently.
- An illegible toggle file is never destructive and never overwritten — state is derived from the bundle rows like a missing file, but not persisted.

The retired `deep-whale-day-night-theme` distribution is documented in `vendor/dsh-plugins/VENDOR.md` (it depended on `dsh-client-ui-theme-plugins` / `dsh-host-theme-catalog`, absent in the pinned rc.6 family, so its patch silently no-oped). Retired built-ins removed because their function overlapped another built-in — `dsh-hotkeys` (npm, covered by `dsh-shortcuts`), `@leetoners/dsh-ui-subagent-monitor` and `dsh-git-graph` (covered by dsh-better-sidebar's Tasks / Git pages), `dsh-thinking-effort` (covered by the provider's models.dev reasoningEfforts), and `@cardo/cardo-provider` (pre-rename workspace built-in, now shipped as `@uniterra-solutions/uniterra-provider`) — are declared `retired: true` in the SAME registry and stripped by `removeRetiredBuiltins()` from already-provisioned profiles on every ensure pass.

### Workspace built-in (`kind: 'workspace'`)

| Source dir                   | Package name                          |
| ---------------------------- | ------------------------------------- |
| `packages/uniterra-provider` | @uniterra-solutions/uniterra-provider |

Ships pre-built (self-contained host bundle, runtime deps inlined) — copied with `package.json` + `lib/` + `cordis.patch.yml`, no pnpm install. See [uniterra-provider.md](uniterra-provider.md).

## Provisioning Semantics

`ensureBuiltinPlugins(dshHome, profile, dshCli, nodeExec, vendorRoot, sourceRoot)` (`builtin.ts`):

1. No-op when the profile dir is missing (never scaffolds).
2. `removeRetiredBuiltins()` — strip retired built-ins' bundle rows, dependency entries, and `node_modules` copies (idempotent; the only pass that can remove them, since step 4 would otherwise early-return on an already-full profile).
3. `reconcileOptionalPlugins()` — enforce the optional-toggle before the gate (enabled ⇒ row + fresh copy; disabled ⇒ row + copy removed; missing ⇒ migrate from bundle rows; illegible ⇒ never destructive).
4. No-op when `hasAllBuiltins` AND no vendored/workspace copy is stale.
5. Write `pnpm-workspace.yaml` (allowBuilds for native deps: node-pty, sharp, protobufjs, fsevents, tesseract.js; `minimumReleaseAge: 0`).
6. `dsh plugin add` each npm spec (env: `DSH_HOME`, `ELECTRON_RUN_AS_NODE=1`).
7. Copy each vendored + workspace built-in into `node_modules/<pkg-name>` and append its bundle row to the profile `package.json` `dsh.profile.bundles` (optional entries are NOT copied here — `reconcileOptionalPlugins` owns them).
8. Expected bundle rows: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, + every active built-in package name EXCEPT optional (an optional row appears only when its toggle enables it).

Staleness (re-provision trigger): installed copy's `package.json` `version` ≠ source `version`, or unreadable — content identity, not bundle-list (a fixed distribution can ship under the same package name). Optional entries are exempt — their freshness is owned by `reconcileOptionalPlugins`. This heals existing profiles on their next launch after a built-in swap.

## Update Policy (bumping a vendored plugin)

Per `vendor/dsh-plugins/VENDOR.md`:

1. `git -C vendor/dsh-plugins/<name> fetch --depth 1 origin`; checkout the new commit.
2. Verify it still targets the uniterra-pinned dsh family (0.1.0-rc.6 / cordis 4.0.1); re-run the smoke test.
3. Update the pin-ledger row in `VENDOR.md`.

Smoke test: sandbox `DSH_HOME`, boot the profile, expect HTTP 200 on the web port with no load error mentioning the plugins.

## Gotchas

- Never hand-edit `vendor/dsh-plugins/` contents — bump via the update policy (AGENTS.md prohibition).
- `vendor/dsh-runtime/` is a legacy 0.5.0 snapshot (its manifest still references the retired `deep-whale-day-night-theme`); the current boot path resolves the dsh CLI from `packages/uniterra-desktop/node_modules` — see [uniterra-desktop.md](uniterra-desktop.md).
- The root `pnpm-workspace.yaml` `minimumReleaseAgeExclude` mirrors the npm built-in set — keep the two lists in sync when adding npm built-ins.

## How to Update

- npm built-in added/removed → declare via `registerBuiltinPlugin({ kind: 'npm', ... })`, extend `builtin-pbt.test.mjs`, update the root `pnpm-workspace.yaml` `minimumReleaseAgeExclude`.
- Vendored plugin added → vendor it, declare `kind: 'vendor'`, update `VENDOR.md` + this table.
- Optional plugin added → vendor it, declare `kind: 'optional'`, document its `.uniterra.json` toggle key here, update `VENDOR.md`.
- Workspace plugin added → declare `kind: 'workspace'`; ensure its build produces a self-contained bundle.

## Find It Fast

```bash
grep -n 'registerBuiltinPlugin({' packages/uniterra-desktop/src/builtin.ts # the registry
grep -n 'kind:' packages/uniterra-desktop/src/builtin.ts                   # the four mechanisms
cat vendor/dsh-plugins/VENDOR.md                                          # pin ledger + update policy
```
