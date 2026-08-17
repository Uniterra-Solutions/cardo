# Module: cardo-skills

**Purpose:** Built-in skill registry — bundles the 10 company-standard skills and provisions them into the agent's skills directory at startup (idempotent, never clobbers user edits; retired skills are removed). In the dsh runtime the same skill tree ships via the rank-600 bundled provider (`DSH_BUNDLED_SKILL_DIR`).

Source: `packages/cardo-skills/src/index.ts`, `src/skills/*/SKILL.md`; build `scripts/copy-skills.mjs`; tests `test/provision.test.mts`.

## Public API

| Export                   | Signature                                                      | Description                                                                                                       |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `builtinSkillNames`      | `readonly BuiltinSkillName[]`                                  | The 10 skill names in provision order                                                                             |
| `listBuiltinSkills`      | `() => BuiltinSkillInfo[]`                                     | Names + frontmatter description + `dist/skills` dir per skill                                                     |
| `provisionBuiltinSkills` | `(agentDir, options?: { force?: boolean }) => ProvisionResult` | Idempotent copy into `<agentDir>/skills/`; retired skills removed; `{ installed, skipped, failed }`; never throws |
| `builtinSkillsDir`       | `() => string`                                                 | `dist/skills` relative to the compiled module                                                                     |
| `resolveAgentDir`        | `() => string`                                                 | `PI_CODING_AGENT_DIR` (tilde-expanded) else `~/.pi/agent`                                                         |

Provision order (`SKILL_NAMES`): `cardo-pbt-debugging`, `cardo-plan`, `cardo-implement`, `cardo-simplify`, `cardo-review`, `manage-agents-md`, `manage-git-repo`, `project-documentation`, `cardo-qa`, `create-skill`.

## Provisioning Mechanics

- Copy source: `dist/skills` → `<agentDir>/skills/<name>`.
- Target exists and `force` unset → skipped (user edits survive restarts).
- `force` → delete + re-copy (re-provision bundled content).
- Retired skills (`cardo-planmode`, split into the four cardo-* skills) are removed from the target dir on every run — the copy loop alone would leave them loaded forever.
- Source `SKILL.md` missing → recorded failure; copy errors never throw.
- `resolveAgentDir()` reimplements pi's `getAgentDir()` — avoids importing the ESM-only pi package from the CJS Electron main bundle.

## Build / Packaging

`build` = `tsc -b` + `scripts/copy-skills.mjs`: mirrors `src/skills/*` → `dist/skills/`, deletes stale `dist/skills` entries (a deleted skill must not keep shipping), and throws if zero skills were copied (fail fast on a wrong path).

## Bundled Skills

| Skill                                       | Trigger (LOAD when)                                                                 | Workflow                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [cardo-plan](#cardo-plan)                   | Plan a feature/task (prd/design/plan/規劃/計畫)                                     | Clarify ≤5 questions → workflow: PRD → design subagents → execution-plan.json (per-task requirements list) → user approval                                                                       |
| [cardo-implement](#cardo-implement)         | Execute an approved plan (execute_plan/執行計畫); implement a well-specified task   | Requirements list → classify: simple = failing PBTs + inline fix; complex = ALL failing PBTs → overlap → batched/parallel workflow                                                               |
| [cardo-simplify](#cardo-simplify)           | Simplify code / cut over-engineering / run the simplify phase (with a review scope) | Establish review scope → workflow fix ↔ simplify-review loop ({verdict, findings} via schema) → pass or round cap                                                                                |
| [cardo-review](#cardo-review)               | Adversarial review / hunt for bugs / run the review phase (with a review scope)     | Establish review scope → workflow fix ↔ adversarial-review loop ({verdict, findings} via schema) → pass or round cap                                                                             |
| [cardo-pbt-debugging](#cardo-pbt-debugging) | Bug report / test failure / wrong behavior in business-logic code                   | Read logic → define invariants → failing PBT reproduction → fix → regression tests                                                                                                               |
| cardo-qa                                    | Verify an app against its PRD (qa/test/驗收/試用)                                   | UI: playwright DOM geometry → screenshot pixel analysis → external-tool UI operation (or playwright E2E); backend: clean-container install + smoke boot → API journeys → fix loop → qa-report.md |
| project-documentation                       | Generate/update/rebuild project docs (寫文檔/更新文檔/重建文檔/項目文檔)            | SCAN → ANALYZE → GENERATE (12 files in dependency order) → VERIFY audit; existing docs → incremental git-diff update                                                                             |
| create-skill                                | Build a new agent skill from scratch                                                | DISCOVER → DESIGN → PLAN → BUILD → VALIDATE → DELIVER                                                                                                                                            |
| manage-agents-md                            | Create/audit agent spec files (AGENTS.md etc.)                                      | Scan 6 core areas → write → audit → drift check                                                                                                                                                  |
| manage-git-repo                             | Commit/version/release/PR workflows                                                 | Commit (dependency order) / Version Release (semver + changelog + `v` tag) / Branch + Batch Commit + PR / Stacked PR                                                                             |

### cardo-plan

The planning phase (Jovaltus methodology). Artifacts live under `<repo>/.plan/<YYYYMMDD>/<plan-name>/`: `clarify.md`, `prd.md`, `design.md`, `execution-plan.json`.

1. **Clarify** — ≤5 open questions one at a time (`ask_user_question`).
2. **PRD + Design subagents** — a `workflow` run dispatches them in order (prompts in `references/prompts/`); the PRD's Functional Requirements list is the project-level requirements list, the design's Business logic surface + PBT plan tell cardo-implement which invariants the red tests must encode.
3. **execution-plan.json** — `execution_mode: serial | batched | parallel`; batches of `{id, task_prompt, requirements}` where `requirements` is the explicit, self-contained requirement list per task (derived from the PRD FRs; every FR covered by ≥1 task); ids `/^[A-Za-z0-9_-]+$/` globally unique.
4. **Approval** — present PRD + design + execution plan to the user before any implementation.

### cardo-implement

PBT-first implementation against an explicit requirements list. The failing property tests are written HERE (red phase), never in the plan.

- **Requirements list first** — from `execution-plan.json` (`requirements` per task) or derived standalone (REQ-1…, confirmed with the user if ambiguous). Every failing test traces to a requirement.
- **Simple tasks** (single-module function changes) — define the business logic as invariants, write the FAILING property tests, implement inline until green. No subagents.
- **Complex tasks** (cross-module features) — write ALL failing property tests first (the whole red suite), then choose the execution mode by task overlap: overlapping tasks → **batched** (parallel within a batch, serial across batches; overlapping tasks in DIFFERENT batches); mutually independent tasks → **full parallel** (one batch, all agents). A `workflow` script mirrors the mode; each agent gets `references/prompts/execute-agent.md` with its `task_prompt` + `requirements` substituted. After the workflow the full suite must be green before review.

### cardo-simplify

Scope-bound simplification review — usable standalone, no plan required. Establishes an explicit review scope (default: uncommitted changes; or the files/refs the user names), then a `workflow` script runs the fix ↔ simplify-review loop: reviewer returns structured `{verdict:'pass'|'fix', findings}` via `schema`; read-only reviewers, uncommitted fixes, cap at `maxRounds` (e.g. 8). Behaviour must be preserved exactly.

### cardo-review

Scope-bound adversarial review — usable standalone, no plan required. Same shape as cardo-simplify, but the reviewer tries to BREAK the changes (bugs, security, races, contract violations) inside the review scope; when a plan exists its requirements are cited in findings.

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

- `SKILL_NAMES` is the single manifest driving provisioning + listing — add a skill there and to `src/skills/<name>/SKILL.md`; retire a skill via `RETIRED_SKILL_NAMES` (its provisioned copy is then removed).
- Skill frontmatter `description:` is parsed as a folded YAML field (continuation lines joined).

## How to Update

- New/renamed skill → edit `SKILL_NAMES`, add the skill dir, run `pnpm run build` (copy-skills refreshes `dist/skills/`; deleted skills stop shipping).
- Retired skill → add to `RETIRED_SKILL_NAMES` so already-provisioned copies are removed.
- Skill content changed → the skill dir itself; no code change needed.

## Find It Fast

```bash
grep -n 'SKILL_NAMES' packages/cardo-skills/src/index.ts   # registry manifest
ls packages/cardo-skills/src/skills/                       # bundled skills
```
