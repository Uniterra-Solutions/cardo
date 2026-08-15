# Common Development Commands

- `pnpm run build` — TypeScript compilation (tsc -b)
- `pnpm run typecheck` — Type-check without emitting output
- `pnpm run lint` — ESLint validation (strictTypeChecked, max-warnings 0 enforced)
- `pnpm run format` — Prettier formatting (single quotes, trailing commas, 100 width, LF)
- `pnpm install --frozen-lockfile` — Install dependencies in CI (never `pnpm install` without `--frozen-lockfile`)
- Desktop app (vendored pi-gui, `vendor/pi-gui/apps/desktop`):
  - `pnpm --filter @pi-gui/desktop dev` — run the Electron app in dev (watch mode). From-source runs (dev server / `electron .` / preview) use the `pi-dev` user-data dir (`~/Library/Application Support/pi-dev`) so they never share the single-instance lock or state files with the packaged app's `pi` dir — see the `// Cardo:` patch in `electron/main.ts` (explicit `PI_APP_USER_DATA_DIR` always wins; e2e harness relies on this)
  - `pnpm --filter @pi-gui/desktop typecheck` — type-check the app + vendored driver packages
  - `pnpm --filter @pi-gui/desktop build` — production electron-vite build
  - `pnpm --filter @pi-gui/desktop test:pbt` — property-based tests for the frontend↔backend contract layer (fast-check + node:test; compiles pure app-store modules via `tsconfig.pbt.json` into `out-pbt/`)
  - `pnpm --filter @pi-gui/desktop run test:cardo:core:multi-window` / `test:cardo:core:mentions-diff` / `test:cardo:core:update-flow` — Playwright e2e specs runnable from the cardo workspace (`@playwright/test` is a desktop devDep — the vendored root's copy is never installed by the cardo workspace). Requires built `out/` + `dist/`; the launch env forces `PI_OFFLINE=1` because specs seed a fake provider key (pi's model-availability refresh would otherwise hang on real network calls) — real-auth specs opt out. The harness also forces `PI_APP_DISABLE_CARDO_UPDATE_CHECK=1` so no spec probes npm/GitHub; the update-flow spec deletes the key via `envOverrides` and feeds a local fixture server + stubbed `dialog.showMessageBox`
  - Layout/visual contracts live in the desktop suite: `tests/core/composer-layout.spec.ts` (single-row, borderless shell, two-state wrapped composer — controls stay flush right), `tests/core/sidebar-ordering.spec.ts` (Today/Earlier buckets, pinned ordering), `tests/core/sidebar-toggle.spec.ts` (toggle flush at the corner, New thread clear of the titlebar strip, collapsed-mode clearances), `tests/core/skills-settings.spec.ts`. Extension-UI behavior contracts live in `tests/live/` (`extension-dock*.spec.ts`, `jovaltus-mode-toggle.spec.ts`). Run from the desktop dir: `PI_APP_TEST_MODE=background PI_OFFLINE=1 PI_APP_DISABLE_CARDO_UPDATE_CHECK=1 node_modules/.bin/playwright test -c playwright.config.ts tests/core/<file>`
  - `pnpm --filter @pi-gui/pi-sdk-driver test` — node:test suite for vendored driver pure functions (includes PBT)
- `packages/jovaltus`:
  - `pnpm --filter @cardo/jovaltus test:pbt` — integrated PBT for the extension ↔ pi-backend interaction (SQLite session store incl. model-based invariants, phase chains, prompt rendering, JSONL protocol, plan-mode tool gating + execute-widget protocol, and the full tool surface against a fake `pi` backend in `test/fixtures/fake-pi.mjs`). Tests import the compiled `dist/` output; the build copies `src/prompts/*.md` → `dist/prompts/` (dist consumers must be able to load phase prompts)
- `packages/general`:
  - `pnpm --filter @cardo/general test` — node:test suite for the system-prompt injection handler (registration, append, no cross-turn duplication)
- `packages/cli`:
  - `pnpm --filter @uniterra-solutions/cardo run build` — compile the installer CLI (tsc -b)
  - `pnpm --filter @uniterra-solutions/cardo run lint` / `typecheck` — lint/type-check the CLI source
  - `pnpm --filter @uniterra-solutions/cardo test` — CLI unit tests (node:test on compiled `dist/`; the stop-app sequence is tested with injected process ops)
- Desktop visual design: token-driven system — see `docs/design-system.md` (03b Warm Paper Sharp: warm palette, 0–4px radii, serif page titles, terracotta accent). Restyles are token changes, not per-component sweeps. Top-left titlebar contract: the sidebar toggle sits flush at the corner (`12px 11px`), the macOS traffic lights are positioned right of it (`trafficLightPosition {x:56, y:18}`, spanning ≈56–110px), and the sidebar's New thread button starts below the 48px strip
- Desktop Jovaltus plan-mode UI (all `// Cardo:` marked): mode button + shift+tab in the composer submit `/planmode` (wired only while the extension's live `jovaltus-mode` status exists, so shift+tab stays native otherwise) and run **silently** — runtime slash commands never paint a timeline message (the composer submit path suppresses the optimistic row); the execute panel above the input (spinner → green light → 3s auto-fade, click opens the right-side graph popup) is rendered natively from the structured `jovaltus-execute` widget — never parses mermaid/free text; the `jovaltus-mode` / `jovaltus-execute` statuses are excluded from the generic extension dock. Components in `apps/desktop/src/jovaltus-ui.tsx`, styles in `styles/jovaltus.css`

# Project Business Goals

- Unified desktop workspace integrating Uniterra's Hermes plugins (Jovaltus, Caelterra, Tabularius, Fabricium) into one surface
- Company-standard workflow: one app that embodies the standard way of working for all agents
- Built on the pi-agent core; plugins stay as separate packages in this monorepo
- The desktop app is pi-gui (vendored under `vendor/pi-gui`), with cardo's extensions registered as **built-in** extensions via `packages/runtime`

# Project Structure

- `packages/*` — pnpm workspace packages (app + shared libraries)
- `packages/general/` — pi-agent extension: app-wide working rules (no emoji, concise replies, no over-engineering, minimal code, verify external APIs, tests per business logic, reply in the user's language) appended to every agent turn's system prompt via a `before_agent_start` handler. Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — see below)
- `packages/jovaltus/` — pi-agent extension: Jovaltus pipeline (`plan`/`execute_plan`/`simplify`/`review` + `list_sessions`/`resume_session`, 6 tools total) plus the plan-mode layer: `plan`/`execute_plan` are plan-mode-gated (`src/plan-mode.ts` — `setActiveTools` + `tool_call` gate; toggle with `/planmode`, shift+P in the TUI, shift+tab / mode button in the desktop composer). Every run is a session row in a SQLite store (`<agentDir>/jovaltus.sqlite`); a non-error stop is recorded as `interrupted` and can be resumed. Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — `jiti.import(path, { default: true })` then `typeof factory === "function"`); all other modules use named exports
- `packages/runtime/` — desktop runtime: built-in extension registry (`builtinExtensionFactories` + `builtinExtensionMetadata`). The app consumes this; add new cardo extensions here
- `packages/skills/` — built-in skill registry: bundles the company-standard skills (5 Jovaltus pipeline skills + Caelterra `create-skill`, vendored from those Hermes plugins) and injects them into the app by provisioning `<agentDir>/skills/` at desktop startup (`provisionBuiltinSkills`); idempotent — existing skills are never clobbered
- `packages/cli/` — public npm installer (`@uniterra-solutions/cardo`, bin `cardo`): one-command macOS app setup/update. Downloads unsigned release zips from GitHub Releases over HTTPS (Node fetch → no `com.apple.quarantine` → Gatekeeper never blocks, no Apple signing needed). Published via `.github/workflows/release.yml` with npm trusted publishing (OIDC) on `v*` tag pushes
- `vendor/pi-gui/` — **git-subtree-managed** third-party desktop app (MIT, `@pi-gui/*` packages + Electron shell). Cardo-specific changes are minimal and marked with `// Cardo:` comments
- Root holds shared tooling only: eslint, prettier, husky, tsconfig.base.json
- Every package extends `tsconfig.base.json` with `rootDir: src`, `outDir: dist`

# Prohibitions

- Never remove `.js` extensions from internal imports — required by NodeNext ESM resolution
- Never use the `any` type — blocked by `no-explicit-any: error`
- Never run `pnpm install` without `--frozen-lockfile` in CI
- Never commit TypeScript files failing ESLint with warnings — pre-commit hook runs `lint-staged` with `--max-warnings 0` at `.husky/pre-commit`
- Never bump Node below 22 — pinned in `.nvmrc` and `package.json`
- Never add default exports — only named exports. **Single platform exception:** the pi extension entry files (`packages/jovaltus/src/index.ts`, `packages/general/src/index.ts`) are default-exported factories because pi's extension loader requires it (see Project Structure)
- Never edit `vendor/` code outside the minimal, commented cardo patches (subtree merges will otherwise conflict); never run the vendored root's composite scripts (`pnpm --dir vendor/pi-gui …`) — cardo's root is the workspace root
- Never point `@cardo/*` package exports at `./src` when the desktop app consumes them — Node cannot load TS source as an externalized dependency; exports point at built `dist`

# Boundaries

**Always:**

- Run `pnpm run lint` and `pnpm run typecheck` before committing
- Add tests for new behaviour
- After changing `packages/jovaltus`, `packages/general`, `packages/runtime`, or `packages/skills` source, run `pnpm run build` — the desktop app resolves them via their `dist` exports
- After changing the pi-gui frontend↔backend contract layer (pure app-store modules, vendored driver pure functions, state/persistence/timeline logic), run the PBT suites: `pnpm --filter @pi-gui/desktop test:pbt` and `pnpm --filter @pi-gui/pi-sdk-driver test`. Properties found failing because of a real bug → fix source with a `// Cardo:` marker + deterministic regression test
- When touching the streaming delivery path (driver event → `electron/stream-publish.ts` coalesced window push → renderer), keep the sync contract locked by `test/pbt/streaming-sync.test.mts`: pushes at most one per `STREAM_PUBLISH_INTERVAL_MS` always carrying the latest state, and timeline rows memoized by content fingerprint so unchanged rows bail out of re-rendering
- After changing desktop styles/tokens (`vendor/pi-gui/apps/desktop/src/styles/*`), run `pnpm --filter @pi-gui/desktop build` + `pnpm --filter @pi-gui/desktop typecheck`, and verify the rendered app against the token contract (see `docs/testing.md` → Visual verification; `docs/design-system.md` for tokens)
- After changing `packages/jovaltus` business logic (state machine / SQLite session store, chains, prompts, dispatch, plan model / plan-mode gating), run `pnpm --filter @cardo/jovaltus test:pbt`. Properties found failing because of a real bug → fix source + add a deterministic regression test with the minimal counterexample

**Ask first:**

- Adding new dependencies to `package.json`
- Changing eslint / prettier / tsconfig rules — they encode the company standard
- Updating the vendored pi-gui subtree (`git subtree pull --prefix vendor/pi-gui https://github.com/minghinmatthewlam/pi-gui <tag> --squash`) — verify pi-coding-agent version alignment between vendor and `packages/*` after pulling

**Never:**

- Commit `.env` files or secrets
- Edit `generated/` or `node_modules/`
