// uniterra-implement workflow — issues #2/#5/#15 (see .plan/20260822/issues-2-5-15/)
// One batch per invocation: args.batch = 1 | 2 | 3 (see task-list.md for the split).
// Subagent prompts are self-contained; each task contract is its red test.

const BATCH = args.batch;

const SHARED_CTX = [
  'Repository: /Users/harry/Documents/uniterra — pnpm workspace monorepo, Node >= 22, NodeNext ESM',
  '(internal imports keep the convention used by the other files in the same package).',
  'Named exports ONLY. Never use any. ESLint strictTypeChecked with --max-warnings 0; prettier single quotes, 100 width, LF.',
  'Shell prefix: export PATH="$HOME/.local/bin:$PATH" (node v22 + pnpm live there; tsc is NOT on PATH — use pnpm exec tsc).',
  'The machine is memory-starved and slow: run builds/tests in the background with generous patience, never parallel heavy builds.',
  'Do NOT commit anything. Do NOT run pnpm install (deps are already installed).',
  'Read the plan docs for full context: .plan/20260822/issues-2-5-15/{prd,design,acceptance,task-list}.md',
].join('\n');

const agentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed'] },
    summary: { type: 'string' },
    redTestsGreen: { type: 'boolean' },
    gates: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['taskId', 'status', 'summary', 'redTestsGreen', 'gates', 'notes'],
};

// ---------------------------------------------------------------------------
// TASK S1 — settings-ui package
// ---------------------------------------------------------------------------
function s1Prompt() {
  return SHARED_CTX + '\n\n' + [
    'TASK S1 — implement the NEW workspace package packages/uniterra-settings-ui (issue #2, FR-2.1/2.2/2.3/2.4/2.7).',
    'The scaffold already exists: src/field-tree.ts, src/widget-registry.ts, src/discovery.ts, src/bridge.ts,',
    'src/index.ts, src/client/apply.ts + tsconfigs + scripts/build-host.mjs + scripts/build-client.mjs +',
    'cordis.patch.yml + package.json. Every module currently throws "not implemented: ..." — implement them.',
    '',
    'CONTRACT — the red tests in test/*.test.mjs are the ONLY signal that work remains. They run against the',
    'built bundle (lib/index.js re-exports the pure modules; see package.json test script: build && node --test "test/*.test.mjs").',
    'Read every test file FIRST and implement exactly what they demand:',
    '  - test/field-tree.test.mjs — toFieldTree(schemaJson, value): schemastery toJSON envelope → FieldNode tree;',
    '    union-of-consts → select with choices; union-of-variant-objects → select with discriminator + variant',
    '    subtrees; array → children "<path>.*.<key>"; empty-child record object (dict:{}) → dict map editor;',
    '    pattern-string → text with pattern; role("secret") → secret; unknown ref type → readonly; PBT: NEVER throws,',
    '    closed FieldNodeType set, string fieldPath. byPath helper.',
    '  - test/widget-registry.test.mjs — createSettingsWidgetRegistry(): register/resolve/list; resolve = exact',
    '    fieldPath first, then longest dot-prefix, else undefined; last-write-wins; list preserves order; PBT resolve never throws.',
    '  - test/discovery.test.mjs — selectNamespaces(inventory, descriptors, ownerMap?): DiscoverySplit',
    '    {withSettings: {extension, namespaces}[], withoutSettings: ExtensionEntry[]}; ownership = ownerMap else',
    '    identity (ns === id); PBT: union = inventory, disjoint, no dups, identity rule.',
    '  - test/bridge.test.mjs — createSettingsBridge(settings, inventory?): handle(endpoint, payload, signal?) over a',
    '    SettingsLike (duck-typed ctx.settings). Endpoints: describe (redactSecrets FORCED true — the test uses a real',
    '    FileSettingsProvider in a tmpdir and asserts redaction even when the caller passes false), update/replace/mutate',
    '    (forward the caller expectedRevision so the seam revision guard fires; SettingsConflictError →',
    '    {ok:false, code:"SETTINGS_CONFLICT", details:{expected,actual}}; other seam errors → code "settings-error"),',
    '    hasDocument/openDocument (→ prepareDocument; openDocument materializes the doc), inventory → the injected',
    '    thunk result; unknown endpoint → {ok:false, code:"unknown-endpoint"}.',
    '  The bridge test spins up a REAL dsh-settings FileSettingsProvider (new Context() + ctx.plugin + register via a',
    '  function plugin + await ctx.start()) — mirror its exact wiring.',
    '',
    'Also implement: src/index.ts apply(ctx) — register a "/settings-ui" host RPC channel',
    '(ctx.inject(["connection"], cctx => connection.rpc.handle("/settings-ui", (endpoint, payload, signal) =>',
    'createSettingsBridge(ctx.settings, inventoryThunk).handle(endpoint, payload, signal), { authority: "loopback" }))',
    'bridging host ctx.settings — follow the provider RPC pattern in packages/uniterra-provider/src/index.ts.',
    'And src/client/: register ONE settings.section page (id "integrations", label "Extensions / Integrations") that',
    'lists namespaces from the bridge describe() and renders the generic form (field-tree → controls, widget registry',
    'overrides), plus the FR-2.7 read-only notice for extensions with no registered namespace and an optional',
    'open-profile-settings-document action (hasDocument/openDocument). The client NEVER reads connection.api.settings.',
    'Provide the widget registry as a client cordis service so other extensions (the provider) can register widgets.',
    '',
    'GATES (all must pass before you report done):',
    '  1. pnpm --filter @uniterra-solutions/uniterra-settings-ui test  → build (tsc -p tsconfig.json + tsc -p',
    '     tsconfig.client.json + esbuild host/client) AND all 4 test files GREEN.',
    '  2. pnpm --filter @uniterra-solutions/uniterra-settings-ui run lint  → clean (--max-warnings 0).',
    '  3. No default exports; no any; imports follow the package convention.',
    'Do NOT touch other packages. Do NOT commit.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TASK S2 — updater decision.ts overlay logic
// ---------------------------------------------------------------------------
function s2Prompt() {
  return SHARED_CTX + '\n\n' + [
    'TASK S2 — extend packages/uniterra-updater/src/decision.ts (issue #15, FR-15.1–15.6 pure surface).',
    '',
    'CONTRACT — test/update-overlay.test.mts is RED (compile errors): dist/decision.js lacks the exported names and',
    'updateInvocation has the wrong signature. Read the test FIRST; implement exactly what it demands:',
    '  - export type OverlayEvent (union: {kind:"status", label:string, version?:string} | {kind:"done", label:string}',
    '    | {kind:"error", message:string} | {kind:"ignore"} — match the test expectations exactly).',
    '  - export function parseUpdateProgress(line: string): OverlayEvent — stage lines → status (parses the version',
    '    from "Downloading source v0.12.0..." → version "v0.12.0"), "Installed ..." → done, /npm ERR!|Failed to update/',
    '    → error, blank → ignore, arbitrary non-blank → status/done/error (never a 4th kind — PBT asserts the closed set).',
    '  - export interface OverlayState + initialOverlayState (phase "init", message mentions Initializing) +',
    '    overlayReducer(state, event) — init{version} → running w/ version; status before init stays init (refused);',
    '    done{version} → success w/ message incl. version and "Restart"; error{message} → failure; terminal absorbs.',
    '  - change updateInvocation(commandOverride: string | undefined, options?: { noOpen?: boolean }) → UpdateInvocation',
    '    {command, args}: undefined override → "npx" + ["--yes", "@uniterra-solutions/uniterra@latest", "update"]',
    '    (append "--no-open" only when options?.noOpen); a command override keeps the existing single-arg behavior',
    '    (existing call sites in uniterra-desktop/src/main.ts still compile — run the desktop typecheck to be sure).',
    '',
    'GATES (all must pass before you report done):',
    '  1. pnpm --filter @uniterra-solutions/uniterra-updater test → build + tsc -p tsconfig.test.json + node --test',
    '     ALL GREEN (decision.test.mts still passes — do not change existing behavior).',
    '  2. pnpm --filter @uniterra-solutions/uniterra-desktop run typecheck (or build) still passes — main.ts call sites',
    '     are compatible.',
    '  3. pnpm exec eslint src test --max-warnings 0 in packages/uniterra-updater → clean.',
    'Do NOT touch other packages. Do NOT commit.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TASK S3 — provider migration
// ---------------------------------------------------------------------------
function s3Prompt() {
  return SHARED_CTX + '\n\n' + [
    'TASK S3 — migrate packages/uniterra-provider to the universal settings UI (issue #2, FR-2.5/2.6).',
    'Prerequisite already satisfied: @uniterra-solutions/uniterra-settings-ui is a workspace devDependency of the',
    'provider and the settings-ui package is implemented (pure widget registry module + client service).',
    '',
    'Read .plan/20260822/issues-2-5-15/design.md Part A (Provider changes) and the settings-ui package exports',
    '(packages/uniterra-settings-ui/src/widget-registry.ts and its client apply) BEFORE editing.',
    '',
    'Files:',
    '  - src/client/apply.ts — STOP registering the settings.section "uniterra" page. Instead register custom widgets',
    '    for ns = llm-uniterra against the settings UI widget registry: model catalog editor (capacity/interrogation),',
    '    write-only API-key secret field, models.dev params panel. The proxy field stays a plain nested object',
    '    (enabled + url) rendered by the generic form — do NOT make it a widget.',
    '    Wire the registration through the client cordis service the settings-ui client provides (match its API exactly —',
    '    read the settings-ui client source; it must not break when the service is absent at boot — register when the',
    '    service is available, defer gracefully otherwise).',
    '  - src/client/widgets/* — new widget components carrying the logic from UniterraSection.tsx.',
    '  - DELETE src/client/UniterraSection.tsx.',
    '  - The Config schemastery schema stays UNCHANGED (it is the generic form source).',
    '',
    'GATES (all must pass before you report done):',
    '  1. pnpm --filter @uniterra-solutions/uniterra-provider test → build (tsc + esbuild host+client → lib/) AND the',
    '     composition/dual-protocol/reasoning suites GREEN.',
    '  2. pnpm --filter @uniterra-solutions/uniterra-provider run lint → clean.',
    '  3. grep -rn "settings.section" packages/uniterra-provider/src → NO registration remains.',
    '  4. packages/uniterra-provider/src/client/UniterraSection.tsx no longer exists.',
    '  5. pnpm --filter @uniterra-solutions/uniterra-desktop test → still green (builtin registry untouched).',
    'Do NOT touch other packages. Do NOT commit. Do NOT change the provider Config schema.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TASK S4 — desktop overlay wiring
// ---------------------------------------------------------------------------
function s4Prompt() {
  return SHARED_CTX + '\n\n' + [
    'TASK S4 — wire the in-app update progress overlay in packages/uniterra-desktop (issue #15, FR-15.1–15.6).',
    'Prerequisite satisfied: packages/uniterra-updater/dist now exports updateInvocation(cmd, {noOpen}),',
    'parseUpdateProgress, initialOverlayState, overlayReducer, OverlayEvent/OverlayState (rebuild it first:',
    'pnpm --filter @uniterra-solutions/uniterra-updater run build).',
    '',
    'Read .plan/20260822/issues-2-5-15/design.md Part C and the existing updater wiring in src/main.ts FIRST.',
    '  NOTE: the CLI final line "Installed <destination>" carries no version token — source <version> for the',
    '    FR-15.3 success message from the update-check result the desktop already holds (resolveUniterraUpdateStatus),',
    '    NOT from the child stdout (pass it to done{version}).',
    'Implement, macOS only (process.platform === "darwin"):',
    '  - "Update Now" spawns the updater as a CHILD PROCESS (spawn updateInvocation(undefined, {noOpen:true}), stdio',
    '    piped) instead of the detached quit-first flow; the app STAYS ALIVE and streams child stdout lines through',
    '    parseUpdateProgress into an overlay driven by overlayReducer (init → running(version) → success/failure).',
    '  - The overlay is an in-app window: window close during the run is blocked (close does nothing until the update',
    '    finishes); failure state shows the error with retry + dismiss (FR-15.6); killing the update child mid-run →',
    '    failure state with retry (FR-15.1), and re-running reinstalls from scratch.',
    '  - Success → app.relaunch() immediately followed by app.quit() with NO await between (FR-15.5); the existing',
    '    before-quit handler still stops dsh before app.exit(0); the second-instance handler restores focus so the',
    '    relaunched app does not collide with a lingering instance.',
    '  - Windows (process.platform !== "darwin") keeps the existing quit-first detached flow unchanged (overlay is',
    '    macOS-only per FR-15.4).',
    '',
    'GATES (all must pass before you report done):',
    '  1. pnpm --filter @uniterra-solutions/uniterra-desktop test → green (builtin-pbt + updater-flow).',
    '  2. pnpm --filter @uniterra-solutions/uniterra-desktop run lint → clean; typecheck clean.',
    '  3. pnpm --filter @uniterra-solutions/uniterra-updater test → still green (decision.ts untouched by you).',
    '  4. Manual QA notes in your summary: what you verified by reading the code (lock/lifecycle/relaunch order).',
    'Do NOT touch other packages. Do NOT commit.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TASK S5 — docs
// ---------------------------------------------------------------------------
function s5Prompt() {
  return SHARED_CTX + '\n\n' + [
    'TASK S5 — docs for issues #2/#5/#15.',
    'Check the CURRENT state of packages/uniterra-desktop/src/builtin.ts (already updated: registry now has 10 npm',
    'plugins including @meomeo-dev/dsh-memory@0.5.6, and a workspace row for @uniterra-solutions/uniterra-settings-ui).',
    '',
    'Files to update:',
    '  - AGENTS.md — the uniterra-desktop project-structure bullet says "9 npm plugins ... 1 vendored plugin + 1',
    '    in-house workspace plugin". Update to 10 npm plugins (dsh-memory pinned at 0.5.6, issue #5) and 2 workspace',
    '    plugins (uniterra-provider + uniterra-settings-ui, issue #2). Keep the prose style and precision.',
    '  - CHANGELOG.md — add entries (top, unreleased) for: issue #2 universal settings UI (new uniterra-settings-ui',
    '    workspace built-in, generic schema-driven settings page replacing the provider bespoke section); issue #5',
    '    dsh-memory 0.5.6 shipped as a built-in; issue #15 in-app update progress overlay with --no-open relaunch',
    '    (macOS). Match the existing changelog style.',
    '  - A short usage note for dsh-memory (issue #5, FR-5.4): point users at /lmemory config set provider uniterra;',
    '    note the model defaults (deepseek-v4-flash / deepseek-v4-pro must exist on the gateway catalog) and the',
    '    keyless-boot note (warmupOnStart:true is local-only — the boot warmup partitions memory sources without calling the model, so keyless boot is quiet; e2e memory tests still need a live key). Put it in the most appropriate',
    '    existing docs file (e.g. the dsh-memory-related docs or docs/ features section — check what exists; do not',
    '    create a new top-level docs file).',
    '',
    'GATES:',
    '  1. Counts in AGENTS.md match builtin.ts exactly (10 npm + 1 optional vendored + 2 workspace + 1 vendored).',
    '  2. CHANGELOG entries follow the existing format; no code changes.',
    'Do NOT touch code. Do NOT commit.',
  ].join('\n');
}

const TASKS = {
  1: [
    { id: 'S1', label: 'settings-ui package', prompt: s1Prompt() },
    { id: 'S2', label: 'updater overlay logic', prompt: s2Prompt() },
  ],
  2: [
    { id: 'S3', label: 'provider migration', prompt: s3Prompt() },
    { id: 'S4', label: 'desktop overlay wiring', prompt: s4Prompt() },
  ],
  3: [
    { id: 'S5', label: 'docs', prompt: s5Prompt() },
  ],
};

const batch = TASKS[BATCH];
if (!batch) throw new Error('unknown batch: ' + BATCH);

phase('batch ' + BATCH + ' — ' + batch.map(t => t.id).join(', '));
log('dispatching ' + batch.length + ' task(s)');

const results = await Promise.all(batch.map(t =>
  agent(t.prompt, { label: t.id + ' — ' + t.label, schema: agentSchema })
    .then(v => v && { taskId: t.id, ...v })
));

const done = results.filter(r => r && r.status === 'done');
const failed = results.filter(r => !r || r.status !== 'done');
if (failed.length > 0) {
  log('FAILED: ' + failed.map(f => (f && f.taskId) || '?').join(', '));
}
return {
  batch: BATCH,
  dispatched: batch.map(t => t.id),
  results: results.filter(Boolean),
  summary:
    (done.length === batch.length ? 'BATCH ' + BATCH + ' GREEN' : 'BATCH ' + BATCH + ' HAS FAILURES') +
    ' — ' + done.length + '/' + batch.length + ' done',
};