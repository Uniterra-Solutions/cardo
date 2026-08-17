# Module: cardo-skills

**Purpose:** Built-in skill registry — bundles the 7 company-standard skills and provisions them into the agent's skills directory at startup (idempotent, never clobbers user edits). In the dsh runtime the same skill tree ships via the rank-600 bundled provider (`DSH_BUNDLED_SKILL_DIR`).

Source: `packages/cardo-skills/src/index.ts`, `src/skills/*/SKILL.md`; build `scripts/copy-skills.mjs`; tests `test/provision.test.mts`.

## Public API

| Export                   | Signature                                                      | Description                                                                               |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `builtinSkillNames`      | `readonly BuiltinSkillName[]`                                  | The 7 skill names in provision order                                                      |
| `listBuiltinSkills`      | `() => BuiltinSkillInfo[]`                                     | Names + frontmatter description + `dist/skills` dir per skill                             |
| `provisionBuiltinSkills` | `(agentDir, options?: { force?: boolean }) => ProvisionResult` | Idempotent copy into `<agentDir>/skills/`; `{ installed, skipped, failed }`; never throws |
| `builtinSkillsDir`       | `() => string`                                                 | `dist/skills` relative to the compiled module                                             |
| `resolveAgentDir`        | `() => string`                                                 | `PI_CODING_AGENT_DIR` (tilde-expanded) else `~/.pi/agent`                                 |

Provision order (`SKILL_NAMES`): `cardo-pbt-debugging`, `cardo-planmode`, `manage-agents-md`, `manage-git-repo`, `project-documentation`, `qa`, `create-skill`.

## Provisioning Mechanics

- Copy source: `dist/skills` → `<agentDir>/skills/<name>`.
- Target exists and `force` unset → skipped (user edits survive restarts).
- `force` → delete + re-copy (re-provision bundled content).
- Source `SKILL.md` missing → recorded failure; copy errors never throw.
- `resolveAgentDir()` reimplements pi's `getAgentDir()` — avoids importing the ESM-only pi package from the CJS Electron main bundle.

## Build / Packaging

`build` = `tsc -b` + `scripts/copy-skills.mjs`: mirrors `src/skills/*` → `dist/skills/`, deletes stale `dist/skills` entries (a deleted skill must not keep shipping), and throws if zero skills were copied (fail fast on a wrong path).

## Bundled Skills

| Skill                                       | Trigger (LOAD when)                                                                                  | Workflow                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [cardo-planmode](#cardo-planmode)           | Plan a feature/task (prd/design/plan); execute an approved plan; simplify/review uncommitted changes | Plan → clarify → PRD/design subagents → failing PBTs + execution-plan.json → execute → simplify/review               |
| [cardo-pbt-debugging](#cardo-pbt-debugging) | Bug report / test failure / wrong behavior in business-logic code                                    | Read logic → define invariants → failing PBT reproduction → fix → regression tests                                   |
| qa                                          | Verify an app against its PRD (qa/test/驗收/試用)                                                    | Detect app type → extract requirements → journey matrix → execute + fix loop → qa-report.md                          |
| project-documentation                       | Generate/maintain project docs (寫文檔/項目文檔)                                                     | SCAN → ANALYZE → GENERATE (12 files in dependency order) → VERIFY audit                                              |
| create-skill                                | Build a new agent skill from scratch                                                                 | DISCOVER → DESIGN → PLAN → BUILD → VALIDATE → DELIVER                                                                |
| manage-agents-md                            | Create/audit agent spec files (AGENTS.md etc.)                                                       | Scan 6 core areas → write → audit → drift check                                                                      |
| manage-git-repo                             | Commit/version/release/PR workflows                                                                  | Commit (dependency order) / Version Release (semver + changelog + `v` tag) / Branch + Batch Commit + PR / Stacked PR |

### cardo-planmode

TDD-style development pipeline on dsh native dynamic workflows. Artifacts live under `<repo>/.plan/<YYYYMMDD>/<plan-name>/`: `clarify.md`, `prd.md`, `design.md`, `execution-plan.json`.

1. **Plan** — clarify ≤5 open questions one at a time (`ask_user_question`); a `workflow` run dispatches PRD then Design subagents (prompts in `references/prompts/`); write the **failing property-based tests** (red phase — must fail against current code; the acceptance contract for execute); write `execution-plan.json` (`execution_mode: serial | batched | parallel`; batches of `{id, task_prompt}`; ids `/^[A-Za-z0-9_-]+$/` globally unique); present for approval.
2. **Execute** — a `workflow` script mirrors the plan shape: `parallel()` of `agent()` calls per batch, batches sequential; prompts from `references/prompts/execute-agent.md` with PRD + design injected; ends `return {status:'done'|'failed'}`.
3. **Simplify / Review** — fix ↔ review loop (round ≥ 2 runs a fix agent first); reviewer returns structured `{verdict:'pass'|'fix', findings}` via `schema`; pass → done; cap at `maxRounds` (e.g. 8) → blocked.

### cardo-pbt-debugging

Invariant-first debugging — turns a bug into a machine-search problem.

1. **Read and search the business logic under investigation** — trace inputs, pure functions, state transitions; find the invariants the code must satisfy.
2. **Define the logic as invariants and reproduce via PBT** — generate arbitrary inputs, assert the property (fast-check); it must FAIL against current code — the counterexample is the reproduction; refine until it fails; keep it as the red phase.
3. **Fix the root cause, then complete unit/regression tests** — PBT goes green; unit tests pin the concrete case; full suite green.

Rules: no code changes before a failing reproduction; prefer properties over unit tests; fall back to the generic evidence-driven loop for non-reducible bugs (I/O, timing) but still add a regression test.

## Dependencies

- Outbound: node builtins only (fs/path); parses YAML frontmatter of SKILL.md in-process.
- Inbound: `packages/cardo-desktop` (provisions at startup); dsh runtime (bundled provider via `DSH_BUNDLED_SKILL_DIR`).

## Patterns & Gotchas

- `SKILL_NAMES` is the single manifest driving provisioning + listing — add a skill there and to `src/skills/<name>/SKILL.md`.
- Skill frontmatter `description:` is parsed as a folded YAML field (continuation lines joined).

## How to Update

- New/renamed skill → edit `SKILL_NAMES`, add the skill dir, run `pnpm run build` (copy-skills refreshes `dist/skills/`; deleted skills stop shipping).
- Skill content changed → the skill dir itself; no code change needed.

## Find It Fast

```bash
grep -n 'SKILL_NAMES' packages/cardo-skills/src/index.ts   # registry manifest
ls packages/cardo-skills/src/skills/                       # bundled skills
```
