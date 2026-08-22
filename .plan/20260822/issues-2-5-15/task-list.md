# Task list — issues #2/#5/#15 implementation (uniterra-implement)

Requirements: .plan/20260822/issues-2-5-15/prd.md · design.md · acceptance.md.
Method: PBT-first — every task's contract is its red test (already written and
confirmed RED in the main session, except where noted). Subagents implement the
stubs; the red tests are the ONLY signal that work remains. NO commit.

Dependency sketch (overlap ⇒ batching):

    S1 settings-ui package (pure modules + bridge + host entry + client page)
    S2 updater decision.ts (overlay logic)          ── parallel batch 1
    S3 provider migration (widgets, drop section)   ── batch 2 (needs S1 + devDep answer)
    S4 desktop main.ts overlay wiring               ── batch 2 (needs S2)
    S5 docs (CHANGELOG, AGENTS.md 9→10, /lmemory)   ── batch 3 (needs final state)

---

## Task S1 — uniterra-settings-ui: pure modules + bridge + host entry + client page

Package: packages/uniterra-settings-ui (NEW workspace built-in).
Contract (red tests, all in test/): field-tree.test.mjs, widget-registry.test.mjs,
discovery.test.mjs, bridge.test.mjs — run via `pnpm --filter @uniterra-solutions/uniterra-settings-ui test`
(build + node --test).

Files (stubs → implementation):

- src/field-tree.ts — toFieldTree(schemaJson, value): schemastery toJSON envelope →
  FieldNode tree. Type map: union-of-consts → select(choices); union-of-objects →
  select(discriminator) + variant subtrees; array → children `<path>.*.<key>`; empty-child
  record object (dict:{}) → dict map editor; pattern-string → text(pattern) (choices only
  where the test demands); role('secret') → secret; unknown ref type → readonly, NEVER
  throws (PBT). Closed FieldNodeType set. byPath helper.
- src/widget-registry.ts — createSettingsWidgetRegistry(): register/resolve/list.
  resolve: exact fieldPath first, then longest dot-prefix, else undefined. Last-write-wins.
  PBT: resolve never throws.
- src/discovery.ts — selectNamespaces(inventory, descriptors, ownerMap?): split into
  withSettings (extension → namespaces) / withoutSettings (no registered ns). Ownership:
  ownerMap else identity (ns === id). PBT: union=inventory, disjoint, no dups.
- src/bridge.ts — createSettingsBridge(settings, inventory?): handle(endpoint, payload)
  over a SettingsLike (duck-typed ctx.settings): describe (redactSecrets FORCED true),
  update/replace/mutate (pass caller's expectedRevision; catch SettingsConflictError →
  {ok:false, code:'SETTINGS_CONFLICT', details:{expected,actual}}; generic seam error →
  code 'settings-error'), hasDocument/openDocument (→ prepareDocument), inventory →
  thunk result; unknown endpoint → {ok:false, code:'unknown-endpoint'}.
- src/index.ts — apply(ctx): register '/settings-ui' host RPC channel
  (ctx.inject(['connection'], cctx => connection.rpc.handle(...))) bridging host
  ctx.settings + extension inventory enumeration; authority loopback.
- src/client/apply.ts + src/client/* — ONE settings.section page (id 'integrations',
  'Extensions / Integrations'), lists namespaces from the bridge describe(), renders the
  generic form per namespace (field-tree → controls, widget registry overrides), read-only
  notice for withoutSettings extensions (FR-2.7) + open-profile-settings-document action;
  provides the widget registry as a client cordis service for extension widgets.

Gates: package test green; tsc -p tsconfig.json + tsconfig.client.json clean;
eslint src --max-warnings 0; build emits lib/index.js (esbuild) + client bundle.

## Task S2 — uniterra-updater: overlay decision logic (pure)

Package: packages/uniterra-updater. Contract (red test): test/update-overlay.test.mts —
`pnpm --filter @uniterra-solutions/uniterra-updater test` (build + tsc test + node --test).

Files:

- src/decision.ts — extend:
  - updateInvocation(commandOverride: string | undefined, options?: { noOpen?: boolean })
    → UpdateInvocation {command, args}: undefined override → npx flow
    ('npx' + ['--yes','@uniterra-solutions/uniterra@latest','update'|'update','--no-open']);
    args append '--no-open' only when options.noOpen (existing call sites keep working —
    commandOverride-only path unchanged).
  - parseUpdateProgress(line: string): OverlayEvent — stage lines → {kind:'status', label,
    version?} ('Downloading source v0.12.0...' → version 'v0.12.0'); 'Installed ...' →
    {kind:'done'}; /npm ERR!|Failed to update/ → {kind:'error'}; blank → {kind:'ignore'};
    arbitrary non-blank → status/done/error (never a 4th kind; PBT).
  - OverlayEvent / OverlayState types + initialOverlayState + overlayReducer (init →
    running(version) → success(message incl. version + 'Restart')/failure(message));
    status before init refused (stays init); terminal states absorb.

Gates: updater test green; lint/typecheck clean; dist rebuilt (desktop resolves dist exports).

## Task S3 — uniterra-provider: migrate settings UI to widgets (issue #2, FR-2.5/2.6)

Package: packages/uniterra-provider. No new red tests (grep/file-existence acceptance
checks + build). Requires: S1 done + user-approved devDep
`@uniterra-solutions/uniterra-settings-ui` (workspace link) in provider package.json.

Files:

- package.json — add devDependency (workspace) once approved.
- src/client/apply.ts — STOP registering settings.section 'uniterra' page; register custom
  widgets against the settings UI widget registry for ns = llm-uniterra:
  model catalog (capacity/interrogation) editor, write-only API-key secret field,
  models.dev params panel. proxy stays a plain nested object (enabled + url) rendered by
  the generic form.
- src/client/widgets/* — widget components (logic moved out of UniterraSection.tsx).
- DELETE src/client/UniterraSection.tsx.

Gates: provider build → lib/ (tsc + esbuild host+client); provider test suite green;
grep: no settings.section registration remains in packages/uniterra-provider;
UniterraSection.tsx gone; desktop builtin-pbt still green (registry unchanged).

## Task S4 — uniterra-desktop: in-app update overlay wiring (issue #15, FR-15.1–15.6)

Package: packages/uniterra-desktop. Requires: S2 (updater dist exports). No PBT (Electron;
smoke/manual QA per acceptance). Design constraints (design.md Part C):

- macOS only: on Update Now, spawn the updater as a CHILD PROCESS (npx ... update --no-open)
  with stdio piped, stream lines through parseUpdateProgress into the overlay
  (init → running → success/failure); app stays alive.
- Window close during the run is blocked (close does nothing until update finishes).
- Killing the update child mid-run → overlay failure state with retry; re-running the
  updater reinstalls from scratch.
- Success → app.relaunch() immediately followed by app.quit() (NO await between);
  before-quit still stops dsh before app.exit(0); second-instance handler restores focus.
- Windows keeps the existing quit-first flow (overlay out of scope).
  Gates: desktop build + builtin-pbt + updater-flow tests green; lint/typecheck clean;
  verify-cli-container run if install flow touched (CI).

## Task S5 — docs (FR-5.4 + regression gates)

- AGENTS.md builtin description: 9 npm plugins → 10 (dsh-memory row) + note the
  settings-ui workspace built-in (project-structure section for uniterra-desktop).
- CHANGELOG.md: issues #2/#5/#15 entries (settings-ui universal settings page; dsh-memory
  built-in; in-app update progress overlay + --no-open relaunch).
- dsh-memory usage doc: `/lmemory config set provider uniterra` (FR-5.4) + model defaults
  (deepseek-v4-flash / deepseek-v4-pro) + keyless-boot note (warmupOnStart:true).
  Gates: docs consistent with final builtin.ts registry (10 npm + 1 vendored + 2 workspace).

## Final gates (main session, after all tasks)

- pnpm run lint && pnpm run typecheck (build first)
- per-package test suites: desktop, provider, updater, settings-ui, skills, systemprompt, cli
- provider build → lib/ current; updater dist rebuilt
- builtin-pbt green with 10 npm specs; NO commit
