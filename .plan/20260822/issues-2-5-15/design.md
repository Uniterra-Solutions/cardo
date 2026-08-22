# Design — Issue 2, 5, 15

Companion to prd.md. Three independent designs; each states module boundaries, data shapes, and the business-logic surface to test.

---

## Part A — Issue 2: uniterra-settings-ui (universal settings)

### Module boundaries

New package packages/uniterra-settings-ui (workspace built-in, @uniterra-solutions/uniterra-settings-ui), with the same host/client split as the provider:

- Host half (src/index.ts): registers the settings UI's **own RPC channels** bridging host `ctx.settings` directly — `describe({ redactSecrets: true })` (returns the descriptor list), `update` / `replace` / `mutate` (revision-guarded; `SETTINGS_CONFLICT` passed through to the caller), plus a document affordance (`hasDocument` / `openDocument`) for the FR-2.7 read-only fallback. The client-facing web settings API (`connection.api.settings`) is **not** used: it serves only the configured provider namespaces plus the web/product settings namespaces and returns `settings-not-exposed` for any other namespace (e.g. `dsh-memory`'s `memory`).
- Browser half (src/client/*): registers ONE settings.section page (id 'integrations', an 'Extensions / Integrations' nav entry) that lists every namespace from the host bridge's describe() and renders a schema-driven form per namespace. Each field maps schema metadata → control; reads and writes go through the settings UI's own host RPC channels (describe/update/replace/mutate). The FR-2.7 read-only fallback for extensions with **no registered settings namespace** shows a read-only notice (the extension exposes no schema-configurable settings) with an optional open-profile-settings-document action via the host bridge's document affordance (hasDocument/openDocument) — no host filesystem path is ever exposed to the browser, and the shared settings document is never presented as the extension's own config.
- Widget registry (src/widgets.ts, exported): registerSettingsWidget(ns, fieldPath, { component }) — an extension can override a plain field's rendering. Type-based defaults (string/number/boolean/enum/object/array/secret) come from the settings UI itself; extensions only register what a plain form cannot express.

Provider changes (packages/uniterra-provider):

- src/client/apply.ts STOPS registering the settings.section 'uniterra' page; instead it registers its custom widgets against the settings UI (model catalog editor, write-only API-key secret field, models.dev params panel) for ns = llm-uniterra (proxy is a plain nested object — enabled + url — rendered by the generic form).
- src/client/UniterraSection.tsx is deleted; its logic moves into the widget components (kept under src/client/widgets/*).
- The Config schemastery schema (already registered via installSettingsSection) is unchanged — it becomes the source the generic form renders.

Registry change (packages/uniterra-desktop/src/builtin.ts):

- registerBuiltinPlugin({ kind: 'workspace', dir: 'packages/uniterra-settings-ui', package: '@uniterra-solutions/uniterra-settings-ui' }) — automatically picked up by expectedBuiltinBundles() / copyBuiltins() / copyBuiltinsStale() (workspace kind = version-identity staleness, like the provider).

### Data shapes

- SettingsDescriptor (already in dsh-settings): { ns, schema (toJSON), value, revision, base?, user?, applies, secrets? } — consumed verbatim; the settings UI never invents its own config model.
- Internal render tree: { fieldPath, label, type, required?, default?, description?, choices?, children?, widget? } derived from schema.toJSON() (schemastery type/meta fields), with user (overridden) vs base (composed) layering surfaced like the current section does. Type coverage: (a) union schemas (retryPolicy) → variant select + the chosen variant's fields — schemastery has no native enum, enums are unions of const schemas rendered as a select; (b) empty-child record objects (providerHints.defaults / models) → key-value map editor; (c) pattern-string (e.g. the provider's api, `z.string().pattern(/^(chat-completions|responses)$/)`) → text input validated against the pattern (selects for enum-like strings come from union-of-consts per (a) — patterns never carry choices; baseURL is a plain `z.string()`, its URL validation is runtime code, not schema).

### Business-logic surface (PBT/unit-testable, pure)

- Schema → field-tree mapper (pure): given schema.toJSON() produce the render tree; unknown types degrade to a read-only text control, never a crash.
- Host bridge is a thin passthrough: write validation, revision-guarding, and redaction stay owned by the host dsh-settings seam; the host channels forward describe/update/replace/mutate and pass SETTINGS_CONFLICT through (no re-implementation in the bridge). The FR-2.7 read-only fallback is keyed off extensions absent from describe() — the host half enumerates them (cordis ctx.registry.forEach runtime names, and/or the desktop's expectedBuiltinBundles()) and serves the read-only notice plus the document affordance (no configPath concept in the browser; the shared profile settings document is never presented as the extension's own config).

### Migration mapping (current → new)

| Current UniterraSection capability                                                                                                   | New home                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain fields (baseURL, api, context window, maxTokens, streamIdleTimeoutMs, proxy, retryPolicy, modelExcludePatterns, providerHints) | Generic schema-driven form (FR-2.3) — api renders as pattern-validated text (pattern-string), retryPolicy as a union variant select, providerHints.defaults/models as record map editors |
| Model catalog editor (capacity K/M input, endpoint interrogation, per-field buffers)                                                 | Registered widget for models field                                                                                                                                                       |
| Write-only API key                                                                                                                   | Secret widget (role('secret'), redacted via describe redactSecrets)                                                                                                                      |
| models.dev params panel (host RPC)                                                                                                   | Registered widget calling the existing models-dev-params RPC                                                                                                                             |
| Localization (zh/en)                                                                                                                 | Reused from the provider's locale.ts into widget components                                                                                                                              |

---

## Part B — Issue 5: @meomeo-dev/dsh-memory built-in

### Module boundaries — one line plus docs

- packages/uniterra-desktop/src/builtin.ts: registerBuiltinPlugin({ kind: 'npm', spec: '@meomeo-dev/dsh-memory@0.5.6' }). Nothing else in code: the registry derives expected bundles, provisioning loops, staleness, and the built-ins PBT.
- Docs to sync: AGENTS.md ('9 npm plugins via dsh plugin add' → 10), docs/modules/uniterra-desktop.md, CHANGELOG.md.
- pnpm-workspace: no allowBuilds addition needed (dependencies: null); the profile workspace already sets minimumReleaseAge: 0. Confirm no root minimumReleaseAgeExclude entry is required (dsh-memory is not a monorepo dep — only a profile plugin).
- Provider-default doc: add a short note to the plan/docs — users routing through the uniterra gateway run '/lmemory config set provider uniterra' (FR-5.4). No provisioning magic.

### Verification surface

- PBT (packages/uniterra-desktop/test/builtin-pbt.test.mjs): existing EXTRACT property — every npm spec contributes its package name to expectedBuiltinBundles() (scoped-name path @scope/name@x.y.z → @scope/name already covered by the arb). The new entry flows in automatically.
- Container replay (scripts/verify-cli-container/run.sh): provisioning PBT asserts the full expected bundle set incl. @meomeo-dev/dsh-memory; real dsh boot resolves it. (CI-only; Docker on this machine is not assumed.)
- Manual e2e (documented, needs a live key): /lmemory recall / extract / review round-trips; /lmemory ui panel renders in the Electron shell.

---

## Part C — Issue 15: in-app update progress overlay

### Module boundaries

packages/uniterra-desktop/src/main.ts — the only substantive code change:

- Replace the 'spawn detached + app.quit()' branch of the update prompt with an updater flow:
  1. Create a small dedicated BrowserWindow ('updating' overlay; no dsh web UI, just spinner + status text; reuse the shell's design tokens).
  2. Spawn the updater as a CHILD PROCESS (not detached): updateInvocation() command with args ['update', '--no-open'], stdio: ['ignore', 'pipe', 'pipe'].
  3. Stream child stdout/stderr lines to the overlay via webContents.send('update:status', ...); the overlay renders a spinner + the latest stage line (Phase 1 message first).
  4. On child exit 0 → overlay shows 'Update to <version> completed. Restarting Uniterra...'; then app.relaunch() immediately followed by app.quit() with **no await between** (the before-quit handler still stops dsh before app.exit(0); if a stale instance races, the existing second-instance handler restores/focuses the fresh one — the single-instance-lock race is avoided by never holding the relaunch on a promise).
  5. On child non-zero → overlay shows the error + guidance (Retry / Open releases page); the app stays alive; user may dismiss or retry.
- Handle window-close during an update (block close or confirm, to avoid killing a running install mid-copy).
- Interrupted updates are tolerated: copyInstalled is non-atomic (rm destination, then ditto), so an interrupt can leave NO working app at the destination; the overlay treats a killed child as failure and offers retry, and re-running the updater reinstalls from scratch (the CLI always rebuilds and re-copies, so a partial destination is repaired rather than terminal).

packages/uniterra-updater/src/decision.ts — small, pure, testable extension:

- updateInvocation gains an options parameter — updateInvocation(commandOverride, { noOpen?: boolean }) — so the overlay flow requests ['update', '--no-open'] and the spawn spec stays unit-tested.
- A parseUpdateProgress(line) pure helper that classifies a CLI stdout line into a stage label / done / error, so the overlay logic is testable without spawning.

packages/uniterra-cli — unchanged in the primary path (it already emits descriptive stage lines and supports --no-open). Optional polish: spinner/progress when stdout is a TTY.

### Data shapes

- Update event to the overlay: { kind: 'status' | 'done' | 'error', line?, version?, error? }.
- The CLI's existing stdout lines are the stage source of truth; no new wire protocol required (keep it minimal).

### Business-logic surface (unit-testable, pure)

- updateInvocation(cmd, { noOpen: true }) → command + args ['update', '--no-open'] (decision.test.mts).
- parseUpdateProgress classification over representative CLI stage lines (decision.test.mts).
- Overlay state machine (init → running → success/failure) kept in main.ts, exercised by manual QA and, where feasible, a smoke test that runs update --dry-run-style output through the parser.

### Why app.relaunch() after --no-open

The install destination (~/Applications/Uniterra.app) is replaced in place by the update; the running instance still holds the single-instance lock while the overlay is alive. Suppressing the CLI's own launch-app (--no-open) avoids a lock race, and app.relaunch(); app.quit() re-executes that same (now updated) path after the current instance exits — macOS only (per FR-15.4/15.5): on Windows the app quits first and the updater runs detached, so the updater's own relaunch is the restart.
