# Workflows

Task recipes. Each links to the module/skill that owns the details.

## Develop a Feature (company standard)

1. Load the `cardo-planmode` skill; clarify ≤5 open questions; write `<repo>/.plan/<YYYYMMDD>/<name>/clarify.md`.
2. Dispatch PRD → Design subagents via a `workflow` script; artifacts `prd.md` / `design.md`.
3. Write failing property-based tests (red phase) at the project's test location.
4. Write `execution-plan.json` (`serial` / `batched` / `parallel`); present for approval.
5. Execute with a `workflow` script mirroring the batches; run the fix ↔ review loop to `verdict: pass`.
   Details: [modules/cardo-skills.md](modules/cardo-skills.md#cardo-planmode).

## Debug a Bug (PBT-first)

1. Load the `cardo-pbt-debugging` skill; read the business logic, find its invariants.
2. Encode the invariants as a fast-check property; run it — it must FAIL (the counterexample is the reproduction). Refine until it fails.
3. Fix the root cause; the PBT goes green; add a unit regression test for the concrete case; run the full suite.
   Details: [modules/cardo-skills.md](modules/cardo-skills.md#cardo-pbt-debugging).

## Add a Bundled Skill

1. Create `packages/cardo-skills/src/skills/<name>/SKILL.md` (use the `create-skill` skill).
2. Add the name to `SKILL_NAMES` in `packages/cardo-skills/src/index.ts`.
3. `pnpm run build` (copy-skills refreshes `dist/skills/`).
4. Extend `packages/cardo-skills/test/provision.test.mts`.

## Bump a Vendored Plugin

1. `git -C vendor/dsh-plugins/<name> fetch --depth 1 origin`; checkout the new commit.
2. Verify dsh-family compatibility (0.1.0-rc.6 / cordis 4.0.1); re-run the smoke test.
3. Update the pin-ledger row in `vendor/dsh-plugins/VENDOR.md`.
   Details: [modules/vendor-plugins.md](modules/vendor-plugins.md).

## Add a Built-in npm Plugin

1. Add the pinned spec to `BUILTIN_NPM_PLUGINS` in `packages/cardo-desktop/src/builtin.ts`.
2. Add it to the root `pnpm-workspace.yaml` `minimumReleaseAgeExclude`.
3. Extend `packages/cardo-desktop/test/builtin-pbt.test.mjs` and update [modules/vendor-plugins.md](modules/vendor-plugins.md).

## Change the Provider

1. Edit `packages/cardo-provider/src/` (translators, adapter, or settings page).
2. New wire shape → per-shape regression + seeded property in `test/reasoning-preservation.test.mjs`.
3. `pnpm --filter @cardo/cardo-provider test`, then root `pnpm run build` — the desktop provisions the built `lib/`.

## Change an Installer/Desktop Behaviour

1. Edit `packages/cardo-cli` or `packages/cardo-desktop`; extend the PBT lanes (platform branches included).
2. `pnpm run build && pnpm run lint && pnpm run typecheck`; per-package tests.
3. Installer/root-script changes additionally: `scripts/verify-cli-container/run.sh` (clean-container replay); Windows branches are exercised by `scripts/verify-windows-install/verify.ps1` in the release gate (windows-latest).

## Release a Version

1. Bump `packages/cardo-cli/package.json` + `packages/cardo-desktop/package.json` versions (+ `CHANGELOG.md` entry), commit, push.
2. Push tag `v<version>` — `release.yml` gates the publish on the full matrix (CI lint/typecheck/tests + clean-container installer replay + windows-latest install verification, all via `needs`); on success it publishes the CLI via npm trusted publishing and creates the GitHub Release (the source archive IS the desktop artifact).
3. Version mismatch between tag and `packages/cardo-cli/package.json` fails the release.
   Details: [modules/cardo-cli.md](modules/cardo-cli.md), [modules/cardo-updater.md](modules/cardo-updater.md).

## Regenerate Documentation

1. Load the `project-documentation` skill (SCAN → ANALYZE → GENERATE → VERIFY).
2. Generate in dependency order; `docs/README.md` LAST; then sync the root README.
3. Run the 5-dimension audit (coverage, links, freshness, quality, diagrams).

## How to Update

- Recipe becomes stale → update the steps and re-check the linked module doc.
- New common task → add a recipe here.

## Find It Fast

```bash
ls packages/cardo-skills/src/skills/   # skills referenced above
```
