# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
