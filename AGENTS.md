# Common Development Commands

- `pnpm run build` — TypeScript compilation (tsc -b)
- `pnpm run typecheck` — Type-check without emitting output
- `pnpm run lint` — ESLint validation (strictTypeChecked, max-warnings 0 enforced)
- `pnpm run format` — Prettier formatting (single quotes, trailing commas, 100 width, LF)
- `pnpm install --frozen-lockfile` — Install dependencies in CI (never `pnpm install` without `--frozen-lockfile`)
- `packages/cardo-systemprompt`:
  - `pnpm --filter @cardo/cardo-systemprompt test` — node:test suite for the system-prompt injection handler (registration, append, no cross-turn duplication)
- `packages/cardo-provider`:
  - `pnpm --filter @cardo/cardo-provider test` — builds, then node:test composition + dual-protocol translate tests (chat completions + Responses API) plus reasoning-preservation regressions and seeded properties (no loss, no duplication, and thinking-mode passback across every gateway wire shape) on the compiled `lib/`
  - `pnpm --filter @cardo/cardo-provider run lint` / `typecheck` — lint/type-check host + client source
- `packages/cardo-skills`:
  - `pnpm --filter @cardo/cardo-skills test` — builds, then runs provisioning tests (every bundled skill ships a SKILL.md; provisioning is idempotent)
- `packages/cardo-cli`:
  - `pnpm --filter @uniterra-solutions/cardo run build` — compile the installer CLI (tsc -b)
  - `pnpm --filter @uniterra-solutions/cardo run lint` / `typecheck` — lint/type-check the CLI source
  - `pnpm --filter @uniterra-solutions/cardo test` — CLI unit tests + install-logic PBT (node:test + fast-check on compiled `dist/`)
- `packages/cardo-desktop`:
  - `pnpm --filter @cardo/cardo-desktop test` — builds, then node:test: profile-bootstrap unit tests + built-ins/readiness PBT (fast-check on compiled `dist/`)
- `scripts/verify-cli-container/run.sh` — reproduces the cardo CLI setup/update flow inside a clean container (pristine source archive → `pnpm install --frozen-lockfile` → `pnpm run build` → `cardo update --dry-run` plan report → dsh CLI / bundled-skills resolution assertions + provisioning PBT + real dsh boot). Requires Docker; the regression net for the installer flow without a macOS runner.
- `scripts/verify-windows-install/verify.ps1` — the Windows counterpart: replays the real `cardo setup --source` on windows-latest (install → build → `--win --dir` packaging → embedded source → Start Menu shortcut → `Cardo.exe` boot smoke to readiness). Runs in CI only (release gate), not on macOS dev machines.

# Project Goals

- A free, non-commercial desktop workspace: one app that unifies the DeepSeek Harness (dsh) agent runtime and its plugins into a single surface
- Assembled for our own use and open-sourced as a shared toolchain — anyone can use it; no paid tiers or revenue model
- The project's working conventions ship as bundled skills (see packages/cardo-skills)

# Project Structure

- `packages/*` — pnpm workspace packages
- `packages/cardo-systemprompt/` — pi-agent extension: app-wide working rules (no emoji, concise replies, no over-engineering, minimal code, verify external APIs, tests per business logic, reply in the user's language) appended to every agent turn's system prompt via a `before_agent_start` handler. Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — see below)
- `packages/cardo-skills/` — built-in skill registry: bundles the standard skills (cardo-plan → cardo-implement → cardo-simplify/cardo-review pipeline, cardo-pbt-debugging, cardo-qa, project-documentation, create-skill, manage-agents-md, manage-git-repo) in `src/skills/*` and copies them to `dist/skills/` via `scripts/copy-skills.mjs` during build. `provisionBuiltinSkills()` provisions them into an agent skills directory at startup; idempotent — existing skills are never clobbered, while retired skill names are removed. In the dsh runtime these ship as the rank-600 bundled provider via `DSH_BUNDLED_SKILL_DIR`
- `packages/cardo-desktop/` — Electron shell over the bundled dsh CLI. Resolves `@deepseek-ai/dsh` from `packages/cardo-desktop/node_modules` (pnpm links the desktop devDependency there — never the workspace root; see `dshCliPath()` in `src/main.ts`). Built-ins are ensured at startup into the profile the run uses (`src/builtin.ts`: 9 npm plugins via `dsh plugin add`, 2 vendored plugins + 1 in-house workspace plugin copied under their package names, bundled skills via `DSH_BUNDLED_SKILL_DIR`; a `RETIRED_BUILTINS` heal strips retired built-ins from already-provisioned profiles). The vendored/workspace copy is re-provisioned when the installed copy's `version` no longer matches the source (`vendoredPluginsStale()` / `workspacePluginsStale()`), so swapping a built-in distribution heals existing profiles whose bundle row is already present. Packaged: resolves everything from the source tree embedded in the app resources (`Contents/Resources/src` on macOS, `resources/src` on Windows — both `process.resourcesPath`); dev: from the monorepo. On Windows `dshCliPath()` resolves through the `.pnpm` store (robocopy materializes pnpm junctions, so the junction path can't resolve dsh's own deps), and the update checker spawns the latest updater via `npx --yes @uniterra-solutions/cardo@latest update` detached before quitting (npm shims are `.cmd` on Windows — `shell: true` resolves them via PATHEXT).
- `packages/cardo-provider/` — in-house dual-protocol LLM provider plugin (`@cardo/cardo-provider`): OpenAI chat completions AND Responses API over any OpenAI-compatible gateway, with models.dev context/output-token auto-detection and a Web settings page. Ships as a workspace built-in (see `BUILTIN_WORKSPACE_PLUGINS` in `builtin.ts`) — the build produces a self-contained `lib/index.js` (runtime deps inlined, only `@deepseek-ai/*` peers external), so the profile copies it like a vendored plugin with no pnpm install. Protocol is per-model overridable (`api: 'chat-completions' | 'responses'`)
- `packages/cardo-cli/` — public npm installer (`@uniterra-solutions/cardo`, bin `cardo`): one-command desktop app setup/update for macOS and Windows. `cardo setup` downloads the release's prebuilt source asset `cardo-src-<tag>.tar.gz` (CI-built dist/lib + a `.cardo-prebuilt` marker; falls back to the GitHub auto-generated tarball for pre-asset releases — or builds `--source <dir>`, a local checkout, the Windows CI verification path), `pnpm install --frozen-lockfile` (with `CI=true` — pnpm 11 aborts without a TTY; pnpm is resolved via `resolvePnpm` → `npx pnpm@<pin>` when absent, self-provisioning the pinned version), then `pnpm run build` only when the marker is absent (`hasPrebuiltSource`, PBT-locked — the marker alone decides), packages with electron-builder `--mac` (→ `.app`) or `--win --dir` (→ `win-unpacked/`; the NSIS installer cannot carry the source embedded afterwards; `signAndEditExecutable: false` — Cardo ships unsigned, and the skip avoids the winCodeSign 7z symlink-extraction failure on Windows without Developer Mode/admin), embeds the whole source tree in the app resources (`Contents/Resources/src` / `resources/src`), and installs to `~/Applications` / `%LOCALAPPDATA%\Programs\Cardo` (plus a best-effort Start Menu shortcut). `cardo update` is the one-command full update: it refreshes the CLI itself first (`npm install -g @uniterra-solutions/cardo@latest` — fail fast before the long build), then rebuilds + reinstalls the app exactly like `cardo setup` and relaunches it (unless `--no-open`). The desktop's Update Now spawns the updater detached before `app.quit()` — by default `npx --yes @uniterra-solutions/cardo@latest update`, so the LATEST updater runs even on machines whose global CLI predates the one-command update — and the updater's relaunch IS the app restart; no separate `cardo setup` needed. The stage plan (`update-cli` → `build-install-app` → `launch-app`) is pure and PBT-locked (`installPlan` in `install-logic.ts`). Platform seams are pure functions in `install-logic.ts` (platform injected, PBT-locked); Windows file ops use `robocopy /MT:16 /R:5 /W:5` (exit codes 0–7 = success) with a same-volume `fs.rename` fast path (ANY rename failure falls back to robocopy). A DOWNLOADED Windows source is embedded via that rename fast path (`embedStrategy` returns `move` only for a downloaded Windows source — a `--source` checkout is never moved away); the release asset is produced by `scripts/make-source-asset.sh`. No Apple signing needed (no quarantine). Root `prepare: "husky || true"` — GitHub source tarballs have no `.git`, so husky must tolerate absence. Published via `.github/workflows/release.yml` with npm trusted publishing (OIDC) on `v*` tag pushes, gated on the full verification matrix (`ci.yml` lint/typecheck/tests + clean-container replay + windows-latest install verification, all via `needs`) — CI publishes the CLI only; the built source asset (`cardo-src-<tag>.tar.gz`) IS the desktop artifact
- `vendor/dsh-plugins/` — pinned community dsh plugins not published to npm (vendored at fixed commits; see `VENDOR.md` pin ledger)
- `scripts/verify-cli-container/` — Docker harness that replays the cardo CLI setup/update flow in a clean container (`run.sh`; the CLI-flow regression net)
- `scripts/verify-windows-install/` — PowerShell harness that replays the real Windows install on windows-latest (`verify.ps1`; the Windows regression net, part of the release gate)
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
- After changing the `cardo setup` install flow or root package scripts, run `scripts/verify-cli-container/run.sh` — it replays the installer flow in a clean container and fails on any regression (no-TTY pnpm install, dsh resolution, bundled skills). Windows branches are exercised by `scripts/verify-windows-install/verify.ps1` in the release gate (windows-latest) — no local run on macOS.

**Ask first:**

- Adding new dependencies to `package.json`
- Changing eslint / prettier / tsconfig rules — they encode the project standard

**Never:**

- Commit `.env` files or secrets
- Edit `generated/` or `node_modules/`
