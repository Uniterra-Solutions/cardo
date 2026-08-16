# Common Development Commands

- `pnpm run build` — TypeScript compilation (tsc -b)
- `pnpm run typecheck` — Type-check without emitting output
- `pnpm run lint` — ESLint validation (strictTypeChecked, max-warnings 0 enforced)
- `pnpm run format` — Prettier formatting (single quotes, trailing commas, 100 width, LF)
- `pnpm install --frozen-lockfile` — Install dependencies in CI (never `pnpm install` without `--frozen-lockfile`)
- `packages/cardo-systemprompt`:
  - `pnpm --filter @cardo/cardo-systemprompt test` — node:test suite for the system-prompt injection handler (registration, append, no cross-turn duplication)
- `packages/cardo-skills`:
  - `pnpm --filter @cardo/cardo-skills test` — builds, then runs provisioning tests (every bundled skill ships a SKILL.md; provisioning is idempotent)
- `packages/cardo-cli`:
  - `pnpm --filter @uniterra-solutions/cardo run build` — compile the installer CLI (tsc -b)
  - `pnpm --filter @uniterra-solutions/cardo run lint` / `typecheck` — lint/type-check the CLI source
  - `pnpm --filter @uniterra-solutions/cardo test` — CLI unit tests (node:test on compiled `dist/`; the stop-app sequence is tested with injected process ops)
- Desktop app (migration in progress): the cardo desktop shell is being rebuilt as a DeepSeek Harness (dsh) profile — Web UI + thin shell, no longer the vendored pi-gui Electron app

# Project Business Goals

- Unified desktop workspace integrating Uniterra's Hermes plugins (Jovaltus, Caelterra, Tabularius, Fabricium) into one surface
- Company-standard workflow: one app that embodies the standard way of working for all agents
- Built on the DeepSeek Harness (dsh) agent runtime; cardo's company knowledge ships as bundled skills

# Project Structure

- `packages/*` — pnpm workspace packages
- `packages/cardo-systemprompt/` — pi-agent extension: app-wide working rules (no emoji, concise replies, no over-engineering, minimal code, verify external APIs, tests per business logic, reply in the user's language) appended to every agent turn's system prompt via a `before_agent_start` handler. Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — see below)
- `packages/cardo-skills/` — built-in skill registry: bundles the company-standard skills (cardo-planmode pipeline, cardo-pbt-debugging, qa, project-documentation, create-skill, manage-agents-md, manage-git-repo) in `src/skills/*` and copies them to `dist/skills/` via `scripts/copy-skills.mjs` during build. `provisionBuiltinSkills()` provisions them into an agent skills directory at startup; idempotent — existing skills are never clobbered. In the dsh runtime these ship as the rank-600 bundled provider via `DSH_BUNDLED_SKILL_DIR`
- `packages/runtime/` — desktop runtime: built-in extension registry (`builtinExtensionFactories` + `builtinExtensionMetadata`) plus the dsh profile spec (`src/dsh-profile.ts`: official bundles, cardo bundles, pinned community plugins, profile env)
- `packages/cardo-cli/` — public npm installer (`@uniterra-solutions/cardo`, bin `cardo`): one-command macOS app setup/update. Downloads unsigned release zips from GitHub Releases over HTTPS (Node fetch → no `com.apple.quarantine` → Gatekeeper never blocks, no Apple signing needed). Published via `.github/workflows/release.yml` with npm trusted publishing (OIDC) on `v*` tag pushes
- `vendor/pi-gui/` — legacy vendored Electron desktop app (git-subtree-managed). Being replaced by the dsh profile + shell; keep cardo patches minimal and `// Cardo:` marked until removal
- `vendor/dsh-plugins/` — pinned community dsh plugins not published to npm (vendored at fixed commits; see `VENDOR.md` pin ledger)
- Root holds shared tooling only: eslint, prettier, husky, tsconfig.base.json
- Every package extends `tsconfig.base.json` with `rootDir: src`, `outDir: dist`

# Prohibitions

- Never remove `.js` extensions from internal imports — required by NodeNext ESM resolution
- Never use the `any` type — blocked by `no-explicit-any: error`
- Never run `pnpm install` without `--frozen-lockfile` in CI
- Never commit TypeScript files failing ESLint with warnings — pre-commit hook runs `lint-staged` with `--max-warnings 0` at `.husky/pre-commit`
- Never bump Node below 22 — pinned in `.nvmrc` and `package.json`
- Never add default exports — only named exports. **Single platform exception:** the pi extension entry file (`packages/cardo-systemprompt/src/index.ts`) is a default-exported factory because pi's extension loader requires it (see Project Structure)
- Never edit `vendor/` code outside the minimal, commented cardo patches (subtree merges will otherwise conflict); never run the vendored root's composite scripts (`pnpm --dir vendor/pi-gui …`) — cardo's root is the workspace root
- Never point `@cardo/*` package exports at `./src` when the desktop app consumes them — Node cannot load TS source as an externalized dependency; exports point at built `dist`
- dsh migration: lock all `@deepseek-ai/*` dependencies at exact versions (no caret) — dsh is a developer preview with breaking changes; `npm view X version` returns the stale `latest` tag (the current family is the `next` tag)

# Boundaries

**Always:**

- Run `pnpm run lint` and `pnpm run typecheck` before committing
- Add tests for new behaviour
- After changing `packages/cardo-systemprompt`, `packages/runtime`, or `packages/cardo-skills` source, run `pnpm run build` — the desktop app resolves them via their `dist` exports
- After changing `packages/cardo-skills/src/skills/*`, run `pnpm run build` so `copy-skills.mjs` refreshes `dist/skills/` (stale entries are removed, so a deleted skill stops shipping)

**Ask first:**

- Adding new dependencies to `package.json`
- Changing eslint / prettier / tsconfig rules — they encode the company standard
- Updating the vendored pi-gui subtree (only relevant until the dsh migration removes it)

**Never:**

- Commit `.env` files or secrets
- Edit `generated/` or `node_modules/`
