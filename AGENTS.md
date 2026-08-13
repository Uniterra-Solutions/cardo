# Common Development Commands

- `pnpm run build` — TypeScript compilation (tsc -b)
- `pnpm run typecheck` — Type-check without emitting output
- `pnpm run lint` — ESLint validation (strictTypeChecked, max-warnings 0 enforced)
- `pnpm run format` — Prettier formatting (single quotes, trailing commas, 100 width, LF)
- `pnpm install --frozen-lockfile` — Install dependencies in CI (never `pnpm install` without `--frozen-lockfile`)
- Desktop app (vendored pi-gui, `vendor/pi-gui/apps/desktop`):
  - `pnpm --filter @pi-gui/desktop dev` — run the Electron app in dev (watch mode)
  - `pnpm --filter @pi-gui/desktop typecheck` — type-check the app + vendored driver packages
  - `pnpm --filter @pi-gui/desktop build` — production electron-vite build
  - `pnpm --filter @pi-gui/desktop test:pbt` — property-based tests for the frontend↔backend contract layer (fast-check + node:test; compiles pure app-store modules via `tsconfig.pbt.json` into `out-pbt/`)
  - `pnpm --filter @pi-gui/pi-sdk-driver test` — node:test suite for vendored driver pure functions (includes PBT)
- `packages/jovaltus`:
  - `pnpm --filter @cardo/jovaltus test:pbt` — integrated PBT for the extension ↔ pi-backend interaction (SQLite session store incl. model-based invariants, phase chains, prompt rendering, JSONL protocol, and the full tool surface against a fake `pi` backend in `test/fixtures/fake-pi.mjs`). Tests import the compiled `dist/` output; the build copies `src/prompts/*.md` → `dist/prompts/` (dist consumers must be able to load phase prompts)
- Desktop visual design: token-driven system — see `docs/design-system.md` (03b Warm Paper Sharp: warm palette, 0–4px radii, serif page titles, terracotta accent). Restyles are token changes, not per-component sweeps

# Project Business Goals

- Unified desktop workspace integrating Uniterra's Hermes plugins (Jovaltus, Caelterra, Tabularius, Fabricium) into one surface
- Company-standard workflow: one app that embodies the standard way of working for all agents
- Built on the pi-agent core; plugins stay as separate packages in this monorepo
- The desktop app is pi-gui (vendored under `vendor/pi-gui`), with cardo's extensions registered as **built-in** extensions via `packages/runtime`

# Project Structure

- `packages/*` — pnpm workspace packages (app + shared libraries)
- `packages/jovaltus/` — pi-agent extension: Jovaltus pipeline (plan/execute/simplify/review + list_sessions/resume_session, 6 tools total). Every run is a session row in a SQLite store (`<agentDir>/jovaltus.sqlite`); a non-error stop is recorded as `interrupted` and can be resumed. Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — `jiti.import(path, { default: true })` then `typeof factory === "function"`); all other modules use named exports
- `packages/runtime/` — desktop runtime: built-in extension registry (`builtinExtensionFactories` + `builtinExtensionMetadata`). The app consumes this; add new cardo extensions here
- `vendor/pi-gui/` — **git-subtree-managed** third-party desktop app (MIT, `@pi-gui/*` packages + Electron shell). Cardo-specific changes are minimal and marked with `// Cardo:` comments
- Root holds shared tooling only: eslint, prettier, husky, tsconfig.base.json
- Every package extends `tsconfig.base.json` with `rootDir: src`, `outDir: dist`

# Prohibitions

- Never remove `.js` extensions from internal imports — required by NodeNext ESM resolution
- Never use the `any` type — blocked by `no-explicit-any: error`
- Never run `pnpm install` without `--frozen-lockfile` in CI
- Never commit TypeScript files failing ESLint with warnings — pre-commit hook runs `lint-staged` with `--max-warnings 0` at `.husky/pre-commit`
- Never bump Node below 22 — pinned in `.nvmrc` and `package.json`
- Never add default exports — only named exports. **Single platform exception:** `packages/jovaltus/src/index.ts` is a default-exported factory because pi's extension loader requires it (see Project Structure)
- Never edit `vendor/` code outside the minimal, commented cardo patches (subtree merges will otherwise conflict); never run the vendored root's composite scripts (`pnpm --dir vendor/pi-gui …`) — cardo's root is the workspace root
- Never point `@cardo/*` package exports at `./src` when the desktop app consumes them — Node cannot load TS source as an externalized dependency; exports point at built `dist`

# Boundaries

**Always:**

- Run `pnpm run lint` and `pnpm run typecheck` before committing
- Add tests for new behaviour
- After changing `packages/jovaltus` or `packages/runtime` source, run `pnpm run build` — the desktop app resolves them via their `dist` exports
- After changing the pi-gui frontend↔backend contract layer (pure app-store modules, vendored driver pure functions, state/persistence/timeline logic), run the PBT suites: `pnpm --filter @pi-gui/desktop test:pbt` and `pnpm --filter @pi-gui/pi-sdk-driver test`. Properties found failing because of a real bug → fix source with a `// Cardo:` marker + deterministic regression test
- After changing desktop styles/tokens (`vendor/pi-gui/apps/desktop/src/styles/*`), run `pnpm --filter @pi-gui/desktop build` + `pnpm --filter @pi-gui/desktop typecheck`, and verify the rendered app against the token contract (see `docs/testing.md` → Visual verification; `docs/design-system.md` for tokens)
- After changing `packages/jovaltus` business logic (state machine / SQLite session store, chains, prompts, dispatch), run `pnpm --filter @cardo/jovaltus test:pbt`. Properties found failing because of a real bug → fix source + add a deterministic regression test with the minimal counterexample

**Ask first:**

- Adding new dependencies to `package.json`
- Changing eslint / prettier / tsconfig rules — they encode the company standard
- Updating the vendored pi-gui subtree (`git subtree pull --prefix vendor/pi-gui https://github.com/minghinmatthewlam/pi-gui <tag> --squash`) — verify pi-coding-agent version alignment between vendor and `packages/*` after pulling

**Never:**

- Commit `.env` files or secrets
- Edit `generated/` or `node_modules/`
