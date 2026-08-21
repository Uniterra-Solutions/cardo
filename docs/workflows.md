# Workflows

Task recipes. Each links to the module/skill that owns the details.

## Develop a Feature (company standard)

1. Load the `uniterra-plan` skill; clarify the requirements list AND architecture design interactively; write `prd.md` / `design.md` / `acceptance.md` under `<repo>/.plan/<YYYYMMDD>/<name>/`.
2. Confirm the plan with the user — read the three docs back with a short summary and ask (`ask_user_question`) whether the content is broadly correct and matches their needs; apply the edits they raise and show the result again until they confirm.
3. Run the plan's review workflow — three parallel review agents (feasibility, over-engineering, verifiable acceptance), then a repair agent applies the failing axes' issues to the docs itself, and only the axes that failed the previous round are re-reviewed (a passed axis is never re-dispatched, so the review-agent count shrinks from 3 toward 0) — until all pass. Each workflow runs through the dsh `workflow` tool: submit `meta` + `script` (from the template) + `args` per the template's instructions.
4. Load `uniterra-implement`: write ALL failing property tests (red phase), decompose into a task list, run the batched / full-parallel `workflow` script (again `meta` + `script` + `args` per the template); confirm the full suite is green.
5. Run `uniterra-review` (adversarial: correctness + security; the review agent confirms each finding by writing a failing regression test before reporting it, so only confirmed findings are reported and stale-doc/comment nits are ignored) and/or `uniterra-simplify` (over-engineering checklist, behaviour-preserving; the plan's design is an authoritative constraint) — each loops until its review agent returns `verdict: "pass"`. The review agent judges pass/fail itself: non-blocking low-severity issues alone never fail a review — the workflow ends and returns them with the result instead of forcing another round.
   Details: [modules/uniterra-skills.md](modules/uniterra-skills.md#uniterra-plan).

## Debug a Bug (PBT-first)

1. Load the `uniterra-pbt-debugging` skill; read the business logic, find its invariants.
2. Encode the invariants as a fast-check property; run it — it must FAIL (the counterexample is the reproduction). Refine until it fails.
3. Fix the root cause; the PBT goes green; add a unit regression test for the concrete case; run the full suite.
   Details: [modules/uniterra-skills.md](modules/uniterra-skills.md#uniterra-pbt-debugging).

## Add a Bundled Skill

1. Create `packages/uniterra-skills/src/skills/<name>/SKILL.md` (model it on an existing bundled skill's `SKILL.md` — same frontmatter `name:` + `description:` structure).
2. Add the name to `SKILL_NAMES` in `packages/uniterra-skills/src/index.ts`.
3. `pnpm run build` (copy-skills refreshes `dist/skills/`).
4. Extend `packages/uniterra-skills/test/provision.test.mts`.

## Bump a Vendored Plugin

1. `git -C vendor/dsh-plugins/<name> fetch --depth 1 origin`; checkout the new commit.
2. Verify dsh-family compatibility (0.1.0-rc.6 / cordis 4.0.1); re-run the smoke test.
3. Update the pin-ledger row in `vendor/dsh-plugins/VENDOR.md`.
   Details: [modules/vendor-plugins.md](modules/vendor-plugins.md).

## Add a Built-in npm Plugin

1. Add the pinned spec as a `registerBuiltinPlugin({ kind: 'npm', spec })` entry in `packages/uniterra-desktop/src/builtin.ts`.
2. Add it to the root `pnpm-workspace.yaml` `minimumReleaseAgeExclude`.
3. Extend `packages/uniterra-desktop/test/builtin-pbt.test.mjs` and update [modules/vendor-plugins.md](modules/vendor-plugins.md).

## Change the Provider

1. Edit `packages/uniterra-provider/src/` (translators, adapter, or settings page).
2. New wire shape → per-shape regression + seeded property in `test/reasoning-preservation.test.mjs`.
3. `pnpm --filter @uniterra-solutions/uniterra-provider test`, then root `pnpm run build` — the desktop provisions the built `lib/`.

## Change an Installer/Desktop Behaviour

1. Edit `packages/uniterra-cli` or `packages/uniterra-desktop`; extend the PBT lanes (platform branches included).
2. `pnpm run build && pnpm run lint && pnpm run typecheck`; per-package tests.
3. Installer/root-script changes additionally: `scripts/verify-cli-container/run.sh` (clean-container replay); Windows branches are exercised by `scripts/verify-windows-install/verify.ps1` in the release gate (windows-latest).

## Release a Version

1. Bump the version declarations — root `package.json`, `packages/uniterra-cli/package.json`, `packages/uniterra-desktop/package.json`, and the version table in `docs/tech-stack.md` — plus a `CHANGELOG.md` entry; commit, push.
2. Push tag `v<version>` — `release.yml` gates the publish on the full matrix (CI lint/typecheck/tests + clean-container installer replay + windows-latest install verification, all via `needs`); on success it publishes the CLI via npm trusted publishing, builds the workspace on Linux, and creates the GitHub Release carrying the `uniterra-src-<tag>.tar.gz` source asset (built tree + `.uniterra-prebuilt` marker).
3. Version mismatch between tag and `packages/uniterra-cli/package.json` fails the release.
   Details: [modules/uniterra-cli.md](modules/uniterra-cli.md), [modules/uniterra-updater.md](modules/uniterra-updater.md).

## Regenerate Documentation

1. Load the `project-documentation` skill (SCAN → ANALYZE → GENERATE → VERIFY).
2. Generate in dependency order; `docs/README.md` LAST; then sync the root README.
3. Run the 5-dimension audit (coverage, links, freshness, quality, diagrams).

## How to Update

- Recipe becomes stale → update the steps and re-check the linked module doc.
- New common task → add a recipe here.

## Find It Fast

```bash
ls packages/uniterra-skills/src/skills/   # skills referenced above
```
