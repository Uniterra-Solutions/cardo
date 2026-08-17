# Common Development Commands

- `pnpm run build` — TypeScript compilation (tsc -b)
- `pnpm run typecheck` — Type-check without emitting output
- `pnpm run lint` — ESLint validation (strictTypeChecked, max-warnings 0 enforced)
- `pnpm run format` — Prettier formatting (single quotes, trailing commas, 100 width, LF)
- `pnpm install --frozen-lockfile` — Install dependencies in CI (never `pnpm install` without `--frozen-lockfile`)
- `packages/cardo-systemprompt`:
  - `pnpm --filter @cardo/cardo-systemprompt test` — node:test suite for the system-prompt injection handler (registration, append, no cross-turn duplication)
- `packages/cardo-provider`:
  - `pnpm --filter @cardo/cardo-provider test` — builds, then node:test composition + dual-protocol translate tests (chat completions + Responses API) plus reasoning-preservation regressions and seeded properties (no loss, no duplication across every gateway wire shape) on the compiled `lib/`
  - `pnpm --filter @cardo/cardo-provider run lint` / `typecheck` — lint/type-check host + client source
- `packages/cardo-skills`:
  - `pnpm --filter @cardo/cardo-skills test` — builds, then runs provisioning tests (every bundled skill ships a SKILL.md; provisioning is idempotent)
- `packages/cardo-cli`:
  - `pnpm --filter @uniterra-solutions/cardo run build` — compile the installer CLI (tsc -b)
  - `pnpm --filter @uniterra-solutions/cardo run lint` / `typecheck` — lint/type-check the CLI source
  - `pnpm --filter @uniterra-solutions/cardo test` — CLI unit tests + install-logic PBT (node:test + fast-check on compiled `dist/`)
- `packages/cardo-desktop`:
  - `pnpm --filter @cardo/cardo-desktop test` — builds, then node:test: profile-bootstrap unit tests + built-ins/readiness PBT (fast-check on compiled `dist/`)
- `scripts/verify-cli-container/run.sh` — reproduces the `cardo setup` CLI flow inside a clean container (pristine source archive → `pnpm install --frozen-lockfile` → `pnpm run build` → dsh CLI / bundled-skills resolution assertions). Requires Docker; the regression net for the installer flow without a macOS runner.

# Project Business Goals

- Unified desktop workspace integrating Uniterra's Hermes plugins (Jovaltus, Caelterra, Tabularius, Fabricium) into one surface
- Company-standard workflow: one app that embodies the standard way of working for all agents
- Built on the DeepSeek Harness (dsh) agent runtime; cardo's company knowledge ships as bundled skills

# Project Structure

- `packages/*` — pnpm workspace packages
- `packages/cardo-systemprompt/` — pi-agent extension: app-wide working rules (no emoji, concise replies, no over-engineering, minimal code, verify external APIs, tests per business logic, reply in the user's language) appended to every agent turn's system prompt via a `before_agent_start` handler. Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — see below)
- `packages/cardo-skills/` — built-in skill registry: bundles the company-standard skills (cardo-planmode pipeline, cardo-pbt-debugging, qa, project-documentation, create-skill, manage-agents-md, manage-git-repo) in `src/skills/*` and copies them to `dist/skills/` via `scripts/copy-skills.mjs` during build. `provisionBuiltinSkills()` provisions them into an agent skills directory at startup; idempotent — existing skills are never clobbered. In the dsh runtime these ship as the rank-600 bundled provider via `DSH_BUNDLED_SKILL_DIR`
- `packages/cardo-desktop/` — Electron shell over the bundled dsh CLI. Resolves `@deepseek-ai/dsh` from `packages/cardo-desktop/node_modules` (pnpm links the desktop devDependency there — never the workspace root; see `dshCliPath()` in `src/main.ts`). Built-ins are ensured at startup into the profile the run uses (`src/builtin.ts`: 10 npm plugins via `dsh plugin add`, 5 vendored plugins + 1 in-house workspace plugin copied under their package names, bundled skills via `DSH_BUNDLED_SKILL_DIR`). The vendored/workspace copy is re-provisioned when the installed copy's `version` no longer matches the source (`vendoredPluginsStale()` / `workspacePluginsStale()`), so swapping a built-in distribution heals existing profiles whose bundle row is already present. Packaged: resolves everything from the source tree embedded as `Contents/Resources/src`; dev: from the monorepo
- `packages/cardo-provider/` — in-house dual-protocol LLM provider plugin (`@cardo/cardo-provider`): OpenAI chat completions AND Responses API over any OpenAI-compatible gateway, with models.dev context/output-token auto-detection and a Web settings page. Ships as a workspace built-in (see `BUILTIN_WORKSPACE_PLUGINS` in `builtin.ts`) — the build produces a self-contained `lib/index.js` (runtime deps inlined, only `@deepseek-ai/*` peers external), so the profile copies it like a vendored plugin with no pnpm install. Protocol is per-model overridable (`api: 'chat-completions' | 'responses'`)
- `packages/cardo-cli/` — public npm installer (`@uniterra-solutions/cardo`, bin `cardo`): one-command macOS app setup/update. `cardo setup` downloads the release's auto-generated source tarball, `pnpm install --frozen-lockfile` (with `CI=true` — pnpm 11 aborts without a TTY), `pnpm run build`, electron-builder `--mac`, embeds the whole source tree under `Contents/Resources/src`, installs to `~/Applications`. `cardo update` updates the CLI ONLY (never rebuilds/reinstalls the app — that is `cardo setup`'s job). No Apple signing needed (no quarantine). Root `prepare: "husky || true"` — GitHub source tarballs have no `.git`, so husky must tolerate absence. Published via `.github/workflows/release.yml` with npm trusted publishing (OIDC) on `v*` tag pushes — CI publishes the CLI only; the source archive IS the desktop artifact
- `vendor/dsh-plugins/` — pinned community dsh plugins not published to npm (vendored at fixed commits; see `VENDOR.md` pin ledger)
- `scripts/verify-cli-container/` — Docker harness that replays the `cardo setup` flow in a clean container (`run.sh`; the CLI-flow regression net)
- Root holds shared tooling only: eslint, prettier, husky, tsconfig.base.json
- Every package extends `tsconfig.base.json` with `rootDir: src`, `outDir: dist`

# Prohibitions

- Never remove `.js` extensions from internal imports — required by NodeNext ESM resolution
- Never use the `any` type — blocked by `no-explicit-any: error`
- Never run `pnpm install` without `--frozen-lockfile` in CI
- Never commit TypeScript files failing ESLint with warnings — pre-commit hook runs `lint-staged` with `--max-warnings 0` at `.husky/pre-commit`
- Never bump Node below 22 — pinned in `.nvmrc` and `package.json`
- Never add default exports — only named exports. **Single platform exception:** the pi extension entry file (`packages/cardo-systemprompt/src/index.ts`) is a default-exported factory because pi's extension loader requires it (see Project Structure)
- Never edit `vendor/dsh-plugins/` — these are pinned upstream copies; bump them via the `VENDOR.md` update policy instead of hand-editing
- Never point `@cardo/*` package exports at `./src` when the desktop app consumes them — Node cannot load TS source as an externalized dependency; exports point at built `dist`. Exception: `@cardo/cardo-provider` emits its esbuild bundle to `lib/` (not `dist/`), so its exports point at `lib/index.js` / `lib/client.js` — and the root `eslint.config.mjs` ignores `**/lib/` alongside `**/dist/` for exactly this reason
- dsh migration: lock all `@deepseek-ai/*` dependencies at exact versions (no caret) — dsh is a developer preview with breaking changes; `npm view X version` returns the stale `latest` tag (the current family is the `next` tag)

# Boundaries

**Always:**

- Run `pnpm run lint` and `pnpm run typecheck` before committing (build first — `tsc -b --noEmit` fails with TS6310 when referenced projects are stale)
- Add tests for new behaviour
- After changing `packages/cardo-systemprompt`, `packages/cardo-skills`, or `packages/cardo-updater` source, run `pnpm run build` — the desktop app resolves them via their `dist` exports
- After changing `packages/cardo-provider` source, run `pnpm run build` — the desktop's workspace built-in provisioning copies `packages/cardo-provider/lib/` (the built bundle) into the profile; stale `lib/` means the profile ships an outdated plugin. `pnpm run build` there is `tsc -p tsconfig.json` + esbuild (host+client)
- After changing `packages/cardo-skills/src/skills/*`, run `pnpm run build` so `copy-skills.mjs` refreshes `dist/skills/` (stale entries are removed, so a deleted skill stops shipping)
- After changing the `cardo setup` install flow or root package scripts, run `scripts/verify-cli-container/run.sh` — it replays the installer flow in a clean container and fails on any regression (no-TTY pnpm install, dsh resolution, bundled skills)

**Ask first:**

- Adding new dependencies to `package.json`
- Changing eslint / prettier / tsconfig rules — they encode the company standard

**Never:**

- Commit `.env` files or secrets
- Edit `generated/` or `node_modules/`
