# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
