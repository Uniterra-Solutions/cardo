# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] — 2026-08-17

### Added

- Windows installer support (`cardo setup`): platform branches in the CLI — `electron-builder --win --dir` produces the `win-unpacked/` layout (the NSIS installer cannot carry the source embedded afterwards), the source tree embeds under `resources/src`, the app installs to `%LOCALAPPDATA%\Programs\Cardo` with a best-effort Start Menu shortcut, and launches as `Cardo.exe`. Windows file ops use `robocopy /MT:16 /R:5 /W:5` (exit codes 0–7 = success) with a same-volume `fs.rename` fast path that degrades to robocopy on any failure (EXDEV cross-volume, EPERM locked files); the macOS flow is byte-for-byte unchanged. npm/pnpm/cardo ship as `.cmd` shims on Windows: the CLI and the desktop run them with `shell: true` (cmd.exe resolves via PATHEXT) and quote whitespace-bearing args
- `cardo setup --source <dir>`: build from a local workspace checkout instead of downloading a release — the Windows CI verification path
- Windows install verification (`scripts/verify-windows-install/verify.ps1`): replays the REAL CLI install on windows-latest — install → build → `--win --dir` packaging → embedded source → install + Start Menu shortcut → `Cardo.exe` boot smoke to a reachable readiness URL
- PR CI workflow (`.github/workflows/ci.yml`): parallel lint / typecheck / tests jobs, callable from the release workflow
- Release gate: `release.yml` publishes only after the full matrix passes (CI + clean-container installer replay + windows-latest install verification, all via `needs`)
- CLI platform-seam PBTs: `win-unpacked` discovery, install destinations, builder args, launch targets, and Start Menu shortcut script quoting (`packages/cardo-cli/test/pbt.test.mts`)

### Changed

- Docs restructured to per-package module docs (cardo-cli / cardo-desktop / cardo-provider / cardo-skills / cardo-systemprompt / cardo-updater / vendor-plugins); cross-platform facts updated across the tree
- `AGENTS.md` documents the cross-platform installer and the gated release flow

## [0.6.2] — 2026-08-17

### Fixed

- `@cardo/cardo-provider` silently dropped reasoning (chain-of-thought) content for most real OpenAI-compatible wire shapes. Chat Completions only read `delta.reasoning_content`, losing `delta.reasoning` (OpenRouter-style aggregators) and the terminal-chunk `message.reasoning_content` / `message.reasoning` full-text replay (DashScope compatible mode); buffered gateways that replay `message.content` / `message.tool_calls` with empty deltas lost text and tool calls too. The Responses API translator only read `response.reasoning_text.delta`, losing `reasoning_summary_text.delta/.done`, complete `reasoning` output items, `content_part` reasoning parts, and the authoritative `response.output` array on `response.completed` / `response.incomplete`. Both translators now consume every shape with per-item dedup (no loss, no duplication), locked by per-shape regressions plus seeded randomized properties (`test/reasoning-preservation.test.mjs`)
- The agent loop never replayed previous turns' reasoning on the wire over the Responses protocol: `serialize-response.ts` now emits a `reasoning` input item (`content` + `summary`) before assistant messages, so OpenAI (requires `summary`) and DeepSeek (merges `content`) both keep conversation state
- `@cardo/cardo-provider` bumps 0.1.0 → 0.1.1: the desktop's `workspacePluginsStale()` guard compares the workspace plugin's source vs installed `version`, so existing profiles re-provision the fixed `lib/` on their next launch

## [0.6.1] — 2026-08-17

### Fixed

- Desktop app would not open after upgrading to v0.6.0: the root `build` script (`cardo setup` runs it on every install) did not run the `@cardo/cardo-provider` esbuild step, so the source archive shipped without `packages/cardo-provider/lib/index.js`. The app then copied a broken provider package into the dsh profile and boot died with `ERR_MODULE_NOT_FOUND` (window never appears, app auto-quits after the 60s readiness timeout). Root `build` now emits the provider bundle (`pnpm --filter @cardo/cardo-provider build`).
- The container harness (`scripts/verify-cli-container`) missed this class of regression: it only asserted install/build/dsh-resolution. It now has a provider-bundle dead gate, a pristine build context (`.dockerignore` excludes local `packages/cardo-provider/lib` build artifacts), and a Docker PBT suite (`pbt/provisioning-pbt.test.mjs`) locking provisioning properties (workspace/vendored built-in entry files, `hasAllBuiltins`, staleness detection) plus a real `dsh --profile web` boot to a reachable readiness URL.

## [0.6.0] — 2026-08-17

### Added

- In-house dual-protocol LLM provider plugin `@cardo/cardo-provider` (`packages/cardo-provider/`): OpenAI chat completions **and** Responses API over any OpenAI-compatible gateway (protocol per-model overridable via `api: 'chat-completions' | 'responses'`), with models.dev context-window / output-token / reasoning-effort auto-detection and a Web settings page (gateway + per-model management, models.dev fetch, proxy support). Ships as a **workspace built-in**: `ensureBuiltinPlugins` gained `BUILTIN_WORKSPACE_PLUGINS` (`workspacePluginsStale()` guard), copying the built package into the profile like a vendored plugin — the host bundle is self-contained (runtime deps inlined, only `@deepseek-ai/*` peers external), so no pnpm install is needed
- Built-in npm plugins extended to 10 (adds `dsh-hotkeys`, `dsh-tool-git`, `dsh-browser-playwright`, `dsh-computer-use`); vendored built-ins extended to 5 (adds `dsh-shortcuts`, `dsh-git-graph` — see `vendor/dsh-plugins/VENDOR.md` pin ledger)
- `AGENTS.md` / `README.md` updated to the dsh/cardo architecture (cardo-provider, workspace built-in provisioning, per-package test commands); root `eslint.config.mjs` ignores `**/lib/` alongside `**/dist/` (cardo-provider's build output)

## [0.5.4] — 2026-08-17

### Fixed

- The built-in whale skin now actually loads. The vendored `deep-whale-day-night-theme` distribution patched the `ui-skin-maid-atelier` roster row that only `@deepseek-ai/dsh-client-ui-theme-plugins` provides (absent in the pinned rc.6 family), so the patch was silently skipped and the plugin never mounted — it also depended on the missing `themeCatalog` service and shipped without the `preview/` assets its host reads at import. The built-in now vendors the standalone `dsh-deep-whale#maid-atelier` distribution (same package name `@dsh-external/dsh-client-ui-skin-maid-atelier`, self-inserting patch, no-op host, art embedded as data URIs, preview assets included). `ensureBuiltinPlugins` gained a version-drift guard (`vendoredPluginsStale`): a vendored copy is re-provisioned when its installed `version` no longer matches the vendored source, so profiles that already carry the old bundle row heal on their next launch. Locked by new VENDOR/STALE property-based invariants in `builtin-pbt.test.mjs`
- Built-in skill provisioning now ships every company skill: `SKILL_NAMES` still listed the retired `agentic-debugging` and omitted `cardo-pbt-debugging` and `cardo-planmode`, so provisioning reported a phantom missing-skill failure every run and never copied two of the seven bundled skills (locked by the existing provisioning tests)

### Changed

- Docs: `AGENTS.md` documents the vendored-plugin staleness guard; `vendor/dsh-plugins/VENDOR.md` updates the pin ledger (`dsh-deep-whale`, commit `873f5c6…`) with the retirement rationale

## [0.5.3] — 2026-08-17

### Added

- Desktop built-in provisioning + PBT (`packages/cardo-desktop/src/builtin.ts`): at startup the profile the run uses gets the 6 npm plugins via `dsh plugin add`, the vendored plugins copied under their package names, and the bundled skills via `DSH_BUNDLED_SKILL_DIR`; dsh CLI resolution and readiness fixes
- CLI source-archive install flow: `cardo setup` downloads the release's auto-generated source tarball → `pnpm install --frozen-lockfile` → build → electron-builder package → install to `~/Applications`; no-TTY pnpm install fix; install-logic PBT
- Docker container harness (`scripts/verify-cli-container`) replaying the `cardo setup` flow in a clean container

### Changed

- Desktop packaging: source-embed — the profile module is manifest constants only; `release.yml` publishes the CLI only (the release source archive is the desktop artifact); root tolerates a missing `.git` for husky

## [0.5.2] — 2026-08-16

### Fixed

- Release artifacts are named with the tag version (`Cardo-<tag>-arm64-mac.zip`), matching the name the updater resolves — `cardo update` works again

## [0.5.1] — 2026-08-16

### Fixed

- CLI release-asset selection is platform-aware (arm64 vs x64) — restores `cardo update` after the publish-package rename

## [0.5.0] — 2026-08-16

### Changed

- Desktop rebuilt on the DeepSeek Harness (dsh) runtime: the Electron shell boots a self-contained bundled `@deepseek-ai/dsh` runtime (`prepare-runtime.mjs` → `resources/dsh-runtime`); the vendored pi-gui desktop and `packages/runtime` extension registry are removed — the pi-gui-era titlebar-strip / silent plan-mode toggle / extension-dock reset UI never shipped, superseded by the dsh shell
- Startup update check extracted into `@cardo/cardo-updater` and wired into the desktop shell
- Plan/debug session modes dropped as a pi extension; the planmode pipeline moved to a bundled skill (cardo-planmode), and agentic-debugging replaced by cardo-pbt-debugging
- Added the cardo dsh profile spec and vendored community dsh plugins (`vendor/dsh-plugins`: dsh-subagent-monitor, dsh-thinking-effort, a day/night whale skin), provisioned into the profile at startup
- CLI renamed to `@uniterra-solutions/cardo`; `release.yml` publishes the CLI via npm trusted publishing (OIDC); the release source archive is the desktop artifact

## [0.4.1] — 2026-08-15

### Fixed

- Desktop transcript delivery no longer republishes the full transcript per driver event (the renderer fell irrecoverably behind on long tasks — agent finishes while the UI still replays). Snapshot + delta delivery: the main process ships a full snapshot on session switch/first publish, then only changed items over the new `pi-gui:transcript-delta` channel; the renderer applies ops locally keeping object identity of untouched rows so the timeline memo comparator short-circuits (sameDisplayItemContent replaces the per-row JSON.stringify). Covered by integrated PBT invariants (convergence under arbitrary coalescing, no-loss/no-dup content, id/kind stability, per-delta liveness, delivery decisions)

## [0.4.0] — 2026-08-15

### Added

- Jovaltus plan mode — `plan`/`execute_plan` are now gated tools of a per-session mode (toggle with `/planmode`, shift+P in the TUI — the TUI keeps shift+tab for `app.thinking.cycle` — or shift+tab / the mode button in the desktop composer). Mode state persists via `pi.appendEntry` and is restored on session start (also via the new `--plan-mode` flag); while off, a direct call is blocked by a `tool_call` gate with an actionable reason
- New plan pipeline: `plan` runs prd → design inside the tool call (asking the user to clarify requirements first when the host has a UI), then parks in `plan_waiting` with a handoff instructing the main agent to write failing PBTs (business logic as invariants — the implementation spec) and `execution-plan.json`; `agent_settled` validates the JSON and marks the plan done
- `execute_plan <plan_id>` replaces `execute`: resolves a completed plan session (id or run dir) and dispatches its subagents — batches serial, agents within a batch parallel — each child getting the role prompt with its task_prompt and the auto-injected PRD/design context. It is plan-mode-exclusive and does not chain into simplify/review; the result carries `execution_mode`, `steps` and the generated mermaid
- Desktop plan-mode UI (vendored pi-gui, `// Cardo:` marked): mode button + shift+tab in the composer, an execute panel above the input (spinner → green light → 3s auto-fade; click opens a right-side graph popup with batch groups, per-agent states and active-batch highlight) rendered natively from the structured `jovaltus-execute` widget protocol — the graph is derived from the same JSON the plan was parsed from, never from mermaid or free text
- Execution-plan model + pure derivations (`parseExecutionPlan`, `deriveExecutionSteps`, `planToMermaid`, the progress machine) with property-based coverage in `plan-*.test.mts` (total parser, mermaid output contract + hostile-prompt escaping, strict batch-gated progress, widget protocol incl. no-`|` collisions, integrated `execute_plan` streaming)

### Changed

- Docs: `AGENTS.md` and `docs/` document the plan-mode pipeline, `execute_plan`, the mode layer and the desktop UI; new `docs/modules/plan.md` + `docs/modules/plan-mode.md`

## [0.3.3] — 2026-08-15

### Added

- Desktop composer: single-row layout with flat inline controls — attach button, textarea, environment/model/thinking selectors and send all on one line inside the surface; environment as a native select with chevron; the new-thread surface follows the same row. Covered by the `composer-layout` e2e spec (geometry, 1px surface border, global scrollbar CSS contract via computed styles) and the composer controls specs

### Fixed

- Desktop streaming delivery: on long tasks the frontend no longer falls irrecoverably behind the backend (the agent finished while the UI kept showing "running" and slowly replayed the work). The driver emits one event per text delta; each event previously shipped a full state + transcript push (several full clones per event) and re-rendered the entire timeline, so delivery cost was O(events²). Window pushes are now coalesced via the new `electron/stream-publish.ts` (at most one per 80ms — leading edge for isolated updates like selection changes and run completion, trailing edge always carrying the latest state) and `conversation-timeline.tsx` memoizes timeline rows by content fingerprint so each snapshot re-renders only the changed rows. The contract is locked by the new `streaming-sync` PBT suite (content accounting, item-identity stability, payload monotonicity, liveness)

### Changed

- Docs: `AGENTS.md`, `docs/architecture.md`, `docs/conventions.md` and `docs/testing.md` document the streaming sync contract (coalesced pushes + memoized rows) and the `streaming-sync.test.mts` PBT lane

## [0.3.2] — 2026-08-15

### Added

- `cardo update` now stops all running cardo desktop app instances before updating: it sends an AppleScript `quit` (letting the app flush its before-quit persistence), polls for up to 10 seconds, then SIGKILLs stragglers. Skipped with `--dry-run`. The process operations are injected (`packages/cli/src/stop-app.ts`) and covered by a new CLI unit suite (`pnpm --filter @uniterra-solutions/cardo test`)
- Desktop startup update check (replaces the vendored pi-gui checker): on launch the app probes the `@uniterra-solutions/cardo` npm `latest` dist-tag and the `Uniterra-Solutions/cardo` GitHub release, and prompts with **Update Now / Later / Skip This Version** when either is newer. Later re-prompts on the next launch; Skip persists the version (no more prompts until a newer one appears). Update Now spawns `cardo update` and quits the app. Manual **Check for Updates…** in the app menu uses the same flow
- The update check only runs outside dev and is disabled entirely with `PI_APP_DISABLE_CARDO_UPDATE_CHECK=1`; endpoints, delay and update command are overridable via `CARDO_UPDATE_API_BASE` / `CARDO_UPDATE_NPM_URL` / `CARDO_UPDATE_DELAY_MS` / `CARDO_UPDATE_COMMAND` (used by the new e2e lane `test:cardo:core:update-flow`)
- Desktop timeline: streaming reasoning renders as a fixed 120px bottom-pinned window — no box surface, 11px mono in `--muted-soft`, and each streamed chunk pins the scroll to the newest content while the model is thinking
- Desktop styling: global 7px thin scrollbars with a transparent track and a `--muted-alpha` warm thumb (sharp 2px corners, Firefox `scrollbar-width: thin` pair), plus a composer footer refactor — attach button far left, status hint and all selectors centered (environment as a native select with chevron, model/thinking badges with caret)

### Changed

- Docs: `AGENTS.md` and `docs/testing.md` document the new CLI test lane and the update-flow e2e lane

### Fixed

- Desktop from-source runs (dev server / `electron .` / preview) now use the `pi-dev` user-data dir instead of sharing the packaged app's `pi` dir, so an orphaned dev electron can no longer hold the single-instance lock or clobber packaged-app state

## [0.3.1] — 2026-08-14

### Added

- Desktop keyboard shortcuts reworked: Cmd+N creates a new thread under the currently selected workspace (previously opened a new window), Cmd+Shift+N opens a new window, and Cmd+Alt+J toggles the files panel. The File menu binds "New Thread" to Cmd+N and "New Window" to Cmd+Shift+N (explicit macOS accelerators, matching Electron's reported form)
- Desktop e2e specs runnable from the cardo workspace: `@playwright/test` is now a desktop devDependency (the vendored root's copy is never installed by the cardo workspace), exposed via the cardo scripts `test:cardo:core:multi-window` and `test:cardo:core:mentions-diff`

### Changed

- Docs: `AGENTS.md` and `docs/testing.md` document the cardo e2e lanes, including the `PI_OFFLINE=1` launch env (specs seed a fake provider key; pi's model-availability refresh would otherwise wait on real network calls — real-auth specs opt out)

### Fixed

- Desktop e2e launch hang in restricted environments: pi's model-availability refresh never resolved, so the test launch env now forces offline mode

## [0.3.0] — 2026-08-14

### Added

- Desktop timeline: streaming reasoning display — `thinking_delta` agent events become a new `assistantThinkingDelta` driver event; the app-store accumulates them into a live thinking block and collapses it to a clickable "Thought for Ns" row (persisted sessions render collapsed, no fabricated duration)
- Desktop timeline: tool-batch collapsing — the consecutive tool calls of one request group into a single "Used N tools" row that auto-expands while calls run and collapses when settled; lone tool calls stay plain rows

### Fixed

- Desktop timeline flicker when tool results and streaming agent output coexisted: `pruneExpandState` returned a fresh `Set` on every transcript change (i.e. every streamed character), defeating React's setState bail-out and re-rendering the timeline three times per character. The pruner now returns the identical reference when nothing is pruned; the invariant is locked by the PBT lane

## [0.2.1] — 2026-08-14

### Added

- `@cardo/general` extension: app-wide working rules (no emoji, concise replies, no over-engineering, minimal code, verify external APIs before use, tests for each piece of business logic, reply in the user's language) appended to the system prompt of every agent turn
- `General` registered as a built-in extension in `@cardo/runtime` (first in the factory chain, before Jovaltus)
- `CHANGELOG.md` — this file

### Changed

- Release workflow hardened for npm trusted publishing: require npm >= 11.5.1 (Node 22's bundled npm 10.x cannot exchange the GitHub OIDC token — `ENEEDAUTH`) and install npm 11 in CI

## [0.2.0] — 2026-08-14

### Added

- `@cardo/skills` built-in skill registry (vendored company-standard skills: 5 Jovaltus pipeline skills + Caelterra `create-skill`)
- Desktop provisions built-in skills into `<agentDir>/skills/` at startup (`provisionBuiltinSkills`, idempotent — existing skills are never clobbered)

### Changed

- Release workflow no longer runs the vendored `verify:packaged-runtime-deps` step (pinned to pi-coding-agent 0.80.6; cardo runs 0.84.x)

## [0.1.0] — 2026-08-14

### Added

- pnpm monorepo scaffold: strict TypeScript, ESLint `strictTypeChecked` (max-warnings 0), Prettier, husky pre-commit
- `@cardo/jovaltus`: Jovaltus pipeline (plan/execute/simplify/review + list_sessions/resume_session, 6 tools) as a pi-agent extension, with SQLite session store (`~/.pi/agent/jovaltus.sqlite`) for cross-session resume
- `@cardo/runtime`: built-in extension registry for the desktop shell
- `@cardo/cli` (`cardo`): one-command macOS app setup/update installer — unsigned release zips over HTTPS (no Gatekeeper quarantine, no Apple signing)
- Vendored pi-gui desktop app (git subtree) with the `extensionFactories` integration seam; `pi-sdk-driver` ported to pi 0.84.1 (`ModelRuntime`)
- Property-based testing lanes (fast-check + node:test) for the extension ↔ pi-backend contract and the pi-gui contract layer
- Warm Paper Sharp design system and project documentation tree (`docs/`)
