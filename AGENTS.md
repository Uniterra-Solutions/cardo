# Common Development Commands

- `pnpm run build` — TypeScript compilation (tsc -b)
- `pnpm run typecheck` — Type-check without emitting output
- `pnpm run lint` — ESLint validation (strictTypeChecked, max-warnings 0 enforced)
- `pnpm run format` — Prettier formatting (single quotes, trailing commas, 100 width, LF)
- `pnpm install --frozen-lockfile` — Install dependencies in CI (never `pnpm install` without `--frozen-lockfile`)

# Project Business Goals

- Unified desktop workspace integrating Uniterra's Hermes plugins (Jovaltus, Caelterra, Tabularius, Fabricium) into one surface
- Company-standard workflow: one app that embodies the standard way of working for all agents
- Built on the pi-agent core; plugins stay as separate packages in this monorepo

# Project Structure

- `packages/*` — pnpm workspace packages (app + shared libraries)
- `packages/jovaltus/` — pi-agent extension: Jovaltus pipeline (plan/execute/simplify/review). Entry `src/index.ts` must stay a **default-exported factory function** (pi's loader contract — `jiti.import(path, { default: true })` then `typeof factory === "function"`); all other modules use named exports
- Root holds shared tooling only: eslint, prettier, husky, tsconfig.base.json
- Every package extends `tsconfig.base.json` with `rootDir: src`, `outDir: dist`

# Prohibitions

- Never remove `.js` extensions from internal imports — required by NodeNext ESM resolution
- Never use the `any` type — blocked by `no-explicit-any: error`
- Never run `pnpm install` without `--frozen-lockfile` in CI
- Never commit TypeScript files failing ESLint with warnings — pre-commit hook runs `lint-staged` with `--max-warnings 0` at `.husky/pre-commit`
- Never bump Node below 22 — pinned in `.nvmrc` and `package.json`
- Never add default exports — only named exports. **Single platform exception:** `packages/jovaltus/src/index.ts` is a default-exported factory because pi's extension loader requires it (see Project Structure)

# Boundaries

**Always:**

- Run `pnpm run lint` and `pnpm run typecheck` before committing
- Add tests for new behaviour

**Ask first:**

- Adding new dependencies to `package.json`
- Changing eslint / prettier / tsconfig rules — they encode the company standard

**Never:**

- Commit `.env` files or secrets
- Edit `generated/` or `node_modules/`
