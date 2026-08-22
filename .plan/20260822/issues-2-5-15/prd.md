# PRD — Issue 2, 5, 15 batch plan

Scope: three independent GitHub enhancements against `Uniterra-Solutions/uniterra` (currently `main` at **v0.11.9**):

- **#2** Universal settings UI extension (every built-in declares config schema; settings UI auto-renders; provider UI migrated).
- **#5** Ship `@meomeo-dev/dsh-memory` as a built-in plugin (long-term memory out of the box).
- **#15** Progress & completion indicators for the update process.

> Naming note: issues #2/#5 were filed in the pre-rename "Cardo" era and reference `packages/cardo-desktop`, `packages/cardo-provider`, `@cardo/cardo-provider`. The live tree uses `packages/uniterra-desktop`, `packages/uniterra-provider`, `@uniterra-solutions/uniterra-provider`. All references below use the current names.

---

## Part A — Issue 2: Universal settings UI

### Background (evidence)

- `packages/uniterra-provider/src/index.ts` defines `Config` as a **schemastery** schema (`z.object`) and registers it with `installSettingsSection(ctx, settingsNamespace('llm-uniterra'), Config, config, hooks)`. Its schema comment states the schema doubles as the settings-section shape.
- `packages/uniterra-provider/src/client/apply.ts` registers a **hand-built** settings page via `ctx.slots.inject('settings.section', ...)` → `UniterraSection` (id `uniterra`, order 15). `UniterraSection.tsx` is ~1079 lines of bespoke React.
- The dsh host settings service (`@deepseek-ai/dsh-settings`) already exposes `describe(options)` returning `SettingsDescriptor[]`: each carries the serialized schemastery schema (`schema.toJSON()`), `value`, `revision`, `base`, `user`, `applies`, and `secrets` (under `redactSecrets`). Writes go through `update` / `replace` / `mutate` (revision-guarded, validation via schema + optional cross-field `validate`).
- The Web settings surface (`@deepseek-ai/dsh-client-ui-settings`) owns the slot contract; `settings.section` is a **list** of pages, each owned by the feature that registers it. There is **no** generic schema-driven page today — every page is hand-built.

### Functional requirements

- **FR-2.1** — Introduce a new workspace built-in `@uniterra-solutions/uniterra-settings-ui` (`packages/uniterra-settings-ui`), registered in `packages/uniterra-desktop/src/builtin.ts` via `registerBuiltinPlugin({ kind: 'workspace', ... })`.
- **FR-2.2** — The settings UI discovers every **configurable extension by its registered dsh-settings namespace** (host `ctx.settings.describe({ redactSecrets: true })`), with its schemastery schema. Discovery goes through the settings UI's **own host bridge** (host RPC channels bridging host `ctx.settings`), **not** the client-facing web settings API — `connection.api.settings` serves only the configured provider namespaces plus the web/product settings namespaces and returns `settings-not-exposed` for any other namespace (e.g. `dsh-memory`'s `memory`).
- **FR-2.3** — It auto-renders a settings form per namespace from the schema metadata: field type → control (string, number, boolean, enum, nested object, array, union, empty-child record object, pattern-string), using the schema's `default`, `description`, choices, and nested shapes. schemastery has **no native enum** — enums are unions of const schemas — so an enum control renders a union-of-consts schema as a select; a union of variant objects (e.g. `retryPolicy`) renders as a variant select plus the chosen variant's fields; empty-child record objects (e.g. `providerHints.defaults` / `models`) render as a key-value map editor; a pattern-string (e.g. the provider's `api` — `z.string().pattern(/^(chat-completions|responses)$/)`) renders as a text input validated against the pattern (union-of-consts → select is covered above; patterns never carry choices). No per-extension UI code for plain fields.
- **FR-2.4** — Changes to schema-backed config fields persist through the dsh-settings write API (`update`/`replace`/`mutate`), reached via the settings UI's **own host bridge** (revision-guarded; `SETTINGS_CONFLICT` passed through to the caller) — **not** the client-facing web settings API, which returns `settings-not-exposed` for namespaces outside its exposure list. The config file stays the source of truth and remains valid against the schema. Users never hand-edit the config file — the only file-open affordance is FR-2.7's escape hatch, surfaced exclusively for extensions with no schema-configurable settings; edits made through it can override form-managed sections (the form re-reads them on the next describe). The single exception is the write-only API key, which is **not** a schema field: it persists through the dsh credentials service (`api.credentials`, ref `uniterra`) via its widget (FR-2.5), never through `update`/`replace`/`mutate`.
- **FR-2.5** — Custom widget support: a registry allows an extension to register a specialised widget for a field (or field path) — or as a **namespace-level virtual widget** not tied to any schema field — that a plain form cannot express. The registry is exposed as a **cordis service on the settings UI client** (the dsh-client-ui-settings `SettingsScopeBinder` pattern) and consumed by the provider's client via `ctx`; cross-plugin client **value** imports are forbidden by the client bundle purity gate, so the provider's esbuild bundle imports no settings-UI client value (type-only references are erased at build time). The provider's complex fields migrate into registered widgets:
  - model catalog editor (K/M-suffixed capacity entry, endpoint interrogation, per-field text buffers),
  - the **write-only** API-key (secret) widget — a namespace-level virtual widget that persists through the dsh credentials service (`api.credentials`, ref `uniterra`), not the settings write API (see FR-2.4),
  - the models.dev params panel (host RPC).
- **FR-2.6** — Migrate the provider: ordinary config fields (`baseURL`, `api`, `defaultContextWindow`, `maxTokens`, `streamIdleTimeoutMs`, `proxy`, `retryPolicy`, `modelExcludePatterns`, `providerHints`, ...) render from schema; the complex fields use registered widgets; the provider **no longer ships its own `settings.section`** page. `UniterraSection.tsx`'s logic moves into the widget registrations; the provider's bespoke section code is removed.
- **FR-2.7** — Graceful fallback for extensions with **no registered settings namespace**: because `ctx.settings.describe()` returns only registered namespaces (every registration carries a schema), the fallback set is keyed off extensions **absent from** `describe()` output. The **host half** enumerates extensions (cordis `ctx.registry.forEach` runtime names, and/or the desktop's `expectedBuiltinBundles()`) and serves, over its own bridge, a read-only notice for each such extension that it exposes **no schema-configurable settings**, plus an optional 'open profile settings document' action — the shared settings document, never presented as the extension's own config file — never a broken UI. The open-document action is the dsh settings seam's own escape hatch, surfaced ONLY for extensions with no schema-configurable settings; edits made through it can override form-managed sections — the form re-reads on the next describe.

### Non-goals (from issue #2 "Out of Scope")

- Editing extension source.
- Plugin install/uninstall UI.
- Config of extensions that expose no schema.

---

## Part B — Issue 5: `@meomeo-dev/dsh-memory` as a built-in

### Background (evidence)

- `packages/uniterra-desktop/src/builtin.ts` holds one declarative `registerBuiltinPlugin` registry. npm built-ins are declared as `{ kind: 'npm', spec: '<name>@<version>' }` and provisioned via `dsh plugin add`. Today there are 9 npm built-ins.
- `@meomeo-dev/dsh-memory@0.5.6` is npm-published with **no runtime dependencies** (`dependencies: null`); its peers (`@deepseek-ai/cordis`, `dsh-llm`, `dsh-tools`, `schemastery`, `dsh-commands`, `dsh-settings`, `dsh-system-prompt`) are all dsh modules the profile resolves against the dsh workspace.
- The built-ins PBT (`packages/uniterra-desktop/test/builtin-pbt.test.mjs`) reads `npmBuiltinSpecs()` **dynamically**, so a new entry is picked up automatically (the `NPM_SPECS.length >= 9` assertion still holds at 10; `RETIRED.length === 5` unchanged).

### Functional requirements

- **FR-5.1** — Add the npm built-in: `registerBuiltinPlugin({ kind: 'npm', spec: '@meomeo-dev/dsh-memory@0.5.6' })` in `builtin.ts`. Exact pin, matching the existing npm-spec format.
- **FR-5.2** — `expectedBuiltinBundles()`, `hasAllBuiltins()`, and the built-ins PBT / container provisioning coverage derive the new plugin automatically (no second code path).
- **FR-5.3** — Verify **provisioning** without a real `DEEPSEEK_API_KEY`: the bundle row is present and the plugin loads. e2e memory behaviour (recall/extract/review) remains a documented manual test (needs a live key, per upstream). Keyless-boot note: `warmupOnStart: true` is local-only — the boot warmup partitions memory sources (reading them from disk) without calling the model (verified against the pinned tarball), so keyless boot is quiet; e2e memory behaviour still needs a live provider key.
- **FR-5.4** — Provider default mismatch: the plugin's `provider` config defaults to `deepseek-official`, and `model` / `reviewModel` default to `deepseek-v4-flash` / `deepseek-v4-pro`; Uniterra users route through the `uniterra` gateway route. Handle by **documenting** `/lmemory config set provider uniterra` **and** that `model` / `reviewModel` must resolve on the uniterra gateway's model catalog — document the default ids (`deepseek-v4-flash` / `deepseek-v4-pro`) and any remap (chosen approach — no provisioning magic). No code change beyond the built-in entry.
- **FR-5.5** — Confirm no native deps → no `allowBuilds` additions to the profile `pnpm-workspace.yaml`; confirm the `/lmemory ui` web panel renders in the Electron shell (web mode).

### Non-goals (from issue #5 "Out of Scope")

- Idle/session-archive post-hoc learning trigger (deliberately dropped by the issue).
- Any fork / local copy — ship the npm package as-is.

---

## Part C — Issue 15: Update progress & completion indicators

### Background (evidence)

- `packages/uniterra-desktop/src/main.ts` `runUniterraStartupUpdateCheck()` shows a native dialog (`Update Now` / `Later` / `Skip This Version`). On `Update Now` it spawns the updater **detached** with `stdio: 'ignore'` (`updateInvocation()`), then `app.quit()`. So the app quits, the update runs invisibly, and the updater relaunches the app when done. The user sees **no** progress/completion signal.
- `packages/uniterra-cli/src/cli.ts` `runInstallPlan('update')` runs the stage plan `update-cli` → `build-install-app` → `launch-app` and writes plain `process.stdout.write(...)` progress lines (no spinner / progress bar / completion banner).
- `packages/uniterra-updater/src/decision.ts` is pure decision logic (prompt/invocation); it has no progress model.
- The CLI already supports `--no-open`, so `launch-app` can be suppressed and the app can own the restart.

### User choice

The user chose **in-app progress overlay** (keep the app alive, run the update as a child process whose output streams to a loading overlay with spinner/status, then relaunch on success).

### Functional requirements

- **FR-15.1** — Phase 1 (initialization): on user consent, immediately surface an `Initializing update...` message acknowledging the start of the process (with a "do not close the application" hint).
- **FR-15.2** — Phase 2 (active progress): continuous, visible feedback during the download and `npm install` phase — a spinner and the current stage label (e.g. "Installing dependencies", "Building packages", "Packaging the desktop app", "Embedding source tree", "Installing to ...").
- **FR-15.3** — Phase 3 (completion): a definitive success or failure message when the update ends, with next-step guidance. Success → `Update to <version> completed. Restarting Uniterra...`. Failure → the error plus guidance (retry, or open the releases page). No ambiguous "silent frozen" state.
- **FR-15.4** — The update runs as a **child process** (not detached) while the app (overlay) stays alive; the CLI is invoked with `--no-open` so it does not self-relaunch. Scoped to **macOS**: replacing the running app's bundle in place is safe there (POSIX unlink of a running bundle). On **Windows** the overlay flow is out of scope — the app quits first and the updater runs detached (the existing quit-first flow) — because `%LOCALAPPDATA%\Programs\Uniterra` is the directory the still-running app executes from and cannot be replaced in place (file locks / delete-pending semantics).
- **FR-15.5** — After a successful update the app **relaunches itself** (`app.relaunch(); app.quit()`), re-executing the freshly-installed binary at the same install path (the bundle was replaced in place), with no conflicting second instance. **macOS only** (per FR-15.4); on Windows the updater's own relaunch after the quit-first flow is the restart.
- **FR-15.6** — On a failed update the app does not quit; the overlay shows the error and the user may retry or dismiss.

### Non-goals / optional

- CLI terminal progress (ora/cli-progress) is **optional** polish for when `uniterra update` is run directly in a terminal; the primary deliverable is the in-app overlay.
