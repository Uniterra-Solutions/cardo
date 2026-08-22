# Module: uniterra-skills

**Purpose:** Built-in skill registry — bundles the 9 company-standard skills and provisions them into the agent's skills directory at startup (idempotent, never clobbers user edits; retired skills are removed). In the dsh runtime the same skill tree ships via the rank-600 bundled provider (`DSH_BUNDLED_SKILL_DIR`).

Source: `packages/uniterra-skills/src/index.ts`, `src/skills/*/SKILL.md`; build `scripts/copy-skills.mjs`; tests `test/provision.test.mts`, `test/workflow-templates.test.mts`.

## Public API

| Export                   | Signature                                                      | Description                                                                                                       |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `builtinSkillNames`      | `readonly BuiltinSkillName[]`                                  | The 9 skill names in provision order                                                                              |
| `listBuiltinSkills`      | `() => BuiltinSkillInfo[]`                                     | Names + frontmatter description + `dist/skills` dir per skill                                                     |
| `provisionBuiltinSkills` | `(agentDir, options?: { force?: boolean }) => ProvisionResult` | Idempotent copy into `<agentDir>/skills/`; retired skills removed; `{ installed, skipped, failed }`; never throws |
| `builtinSkillsDir`       | `() => string`                                                 | `dist/skills` relative to the compiled module                                                                     |
| `resolveAgentDir`        | `() => string`                                                 | `PI_CODING_AGENT_DIR` (tilde-expanded) else `~/.pi/agent`                                                         |

Provision order (`SKILL_NAMES`): `uniterra-pbt-debugging`, `uniterra-plan`, `uniterra-implement`, `uniterra-simplify`, `uniterra-review`, `manage-agents-md`, `manage-git-repo`, `project-documentation`, `uniterra-qa`.

## Provisioning Mechanics

- Copy source: `dist/skills` → `<agentDir>/skills/<name>`.
- Target exists and `force` unset → skipped (user edits survive restarts).
- `force` → delete + re-copy (re-provision bundled content).
- Retired skills (`uniterra-planmode`, split into the four uniterra-* skills) are removed from the target dir on every run — the copy loop alone would leave them loaded forever.
- Source `SKILL.md` missing → recorded failure; copy errors never throw.
- `resolveAgentDir()` reimplements pi's `getAgentDir()` — avoids importing the ESM-only pi package from the CJS Electron main bundle.

## Build / Packaging

`build` = `tsc -b` + `scripts/copy-skills.mjs`: mirrors `src/skills/*` → `dist/skills/`, deletes stale `dist/skills` entries (a deleted skill must not keep shipping), and throws if zero skills were copied (fail fast on a wrong path).

## Workflow Templates & the dsh `workflow` Tool Contract

The four pipeline skills (`uniterra-plan` / `uniterra-implement` / `uniterra-review` /
`uniterra-simplify`) dispatch their agents through the dsh `workflow` tool. Every
template embeds the script as a ` ```js ` code fence and MUST instruct the full
submission contract, or a workflow taken straight from the template fails before the
script runs:

- **`meta` is a separate, REQUIRED tool parameter** (`meta: { name, description }`),
  never part of the script body — dsh rejects a body opening with
  `export const meta` (`SCRIPT_PARSE`). Only `name` / `description` / optional
  `whenToUse` / `phases` (with only `title` / `detail` / `provider` / `model`) are
  recognized; any other meta field fails the run with `META_INVALID`.
- **Make ONE `workflow` call** — `meta`, `script`, and `args` are three properties of ONE
  `arguments` object. Never split them across parallel `workflow` calls (each partial call
  fails `missing required property "meta"` / `"script"`) and never wrap them under a field
  named `arguments` (fails `"arguments" must be an object`).
- **`script`** is the plain-JS body only (no TypeScript), compiled as
  `(async () => { <body> })()`, ending with `return <json-value>`.
- **`args`** is free-form JSON exposed as the `args` global.
- Hooks available in the script realm: `agent(prompt, opts)`, `parallel(thunks)`,
  `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`. `agent()`
  accepts only `label` / `phase` / `schema` / `provider` / `model` (anything else is
  rejected loudly); `schema` must be object-rooted and use only
  `type` / `properties` / `required` / `additionalProperties` / `items` / `enum` /
  `const` / `oneOf`.
- **Subagent reports to the workflow are JSON** — every `agent(...)` call passes a
  `schema`, and its return is the validated JSON object. Only the subagent **input
  prompt** is text/markdown; never convert the schema-validated return to markdown.

Fixed templates (plan / review / simplify / implement) embed the script as a ` ```js `
fence that the agent copies verbatim, filling only `meta` + `args`; `uniterra-implement`
consolidates both orchestration shapes (parallel and batched) into a single fixed script
that branches on `args.tasks` (flat, full parallel) vs `args.batches` (array of task
arrays, serial across batches).

`test/workflow-templates.test.mts` locks this: every embedded ` ```js ` fence parses
under dsh's wrapper, no body opens with `export const meta`, every template instructs
the `meta` parameter, and the single-script templates execute to a terminal JSON
result under stubbed hooks. Keep templates inside this contract when editing them.

## Bundled Skills

| Skill                                             | Trigger (LOAD when)                                                                 | Workflow                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [uniterra-plan](#uniterra-plan)                   | Plan a feature/task (prd/design/plan/規劃/計畫)                                     | Clarify requirements + design interactively → write prd.md / design.md / acceptance.md → confirm the plan with the user → 3 parallel review agents → repair agent applies failing issues → re-review only the failed axes until all pass |
| [uniterra-implement](#uniterra-implement)         | Execute an approved plan (execute_plan/執行計畫); implement a well-specified task   | Requirements + design → write ALL failing PBTs → decompose into a task list → batched/parallel workflow of subagents → full suite green                                                                                                  |
| [uniterra-simplify](#uniterra-simplify)           | Simplify code / cut over-engineering / run the simplify phase (with a review scope) | goal + context (requirements/design/acceptance) → review (over-engineering checklist — plan design is authoritative, safe/risky, pass/fail verdict) → fix → re-review loop until pass                                                    |
| [uniterra-review](#uniterra-review)               | Adversarial review / hunt for bugs / run the review phase (with a review scope)     | goal + context → review (correctness + security, critical/high/medium/low, pass/fail verdict; each finding confirmed by a failing test — only confirmed findings reported, no stale-doc/comment nits) → fix → re-review loop until pass  |
| [uniterra-pbt-debugging](#uniterra-pbt-debugging) | Bug report / test failure / wrong behavior in business-logic code                   | Read logic → define invariants → failing PBT reproduction → fix → regression tests                                                                                                                                                       |
| uniterra-qa                                       | Verify an app against its PRD (qa/test/驗收/試用)                                   | UI: playwright DOM geometry → screenshot pixel analysis → external-tool UI operation (or playwright E2E); backend: clean-container install + smoke boot → API journeys → fix loop → qa-report.md                                         |
| project-documentation                             | Generate/update/rebuild project docs (寫文檔/更新文檔/重建文檔/項目文檔)            | SCAN → ANALYZE → GENERATE (12 files in dependency order) → VERIFY audit; existing docs → incremental git-diff update                                                                                                                     |
| manage-agents-md                                  | Create/audit agent spec files (AGENTS.md etc.)                                      | Scan 6 core areas → write → audit → drift check                                                                                                                                                                                          |
| manage-git-repo                                   | Commit/version/release/PR workflows                                                 | Commit (dependency order) / Version Release (semver + changelog + `v` tag) / Branch + Batch Commit + PR / Stacked PR                                                                                                                     |

### uniterra-plan

The planning phase (Jovaltus methodology). Artifacts live under `<repo>/.plan/<YYYYMMDD>/<plan-name>/`: `prd.md`, `design.md`, `acceptance.md`.

1. **Clarify** — interactively complete the requirements list AND the architecture design with the user (`ask_user_question`).
2. **Write the three docs yourself** (no authoring subagents) — `prd.md` (Functional Requirements list), `design.md` (architecture), `acceptance.md` (one acceptance criterion per requirement, each naming an objective verifiable piece of evidence).
3. **Confirm with the user** — before the automated review, read the three docs back with a short summary and ask via `ask_user_question` whether the content is broadly correct and matches their needs; apply any edits they raise and show the result again, then proceed only once they confirm.
4. **Review workflow** (`scripts/review-workflow.md`) — three parallel review agents, each fed `prd_dir` / `design_dir` / `acceptance_dir`: requirement-list-review (technical feasibility + contradictions), design-review (over-engineering / minimal complexity / minimal invasiveness / necessary vs unnecessary libraries), acceptance-review (clarity + objective verifiable evidence). The failing axes' issues go to a single repair agent that applies them to the docs itself; then only the axes that FAILED the previous round are re-reviewed — an axis that already passed is never re-dispatched, so the review-agent count shrinks from 3 toward 0. Re-run until all pass.

### uniterra-implement

PBT-first implementation against an explicit requirements list. The failing property tests are written HERE (red phase), never in the plan.

1. **Requirements + design** — read the plan's `prd.md` + `design.md`, or build them interactively (`ask_user_question`) when no design exists; clarify any ambiguous requirement.
2. **Write ALL failing property tests** in the main session (the red suite), then decompose requirements + design into a **task list** (`assets/task-list-example.md`): one entry per task with its requirements (each pointing at the covering test), context files, conventions, and owned / forbidden file sets.
3. **Workflow** (`assets/workflow-template.md`) — one fixed script (copy verbatim) handles both shapes: set `args.tasks` (flat) for full parallel when tasks are independent, or `args.batches` (array of task arrays, serial across batches) when they overlap. Each task carries a pre-rendered markdown `prompt` (goal + context + requirements + conventions + constraints) and returns `{changed_files, satisfied_requirements, deviations}` via schema. Each subagent works against the failing tests written in step 2 and **prioritizes STRENGTHENING / completing those test cases** (extend the property, add the missing edge cases and invariant asserts) rather than writing a fresh property test from scratch each time. After the workflow the full suite must be green before review.

### uniterra-simplify

Behaviour-preserving simplification — usable standalone, no plan required. Assemble a goal + context (requirements / design / acceptance, from docs or written directly), then a `workflow` loops review → fix → re-review: the review agent returns a verdict (`pass` | `fail`) plus simplification opportunities against the over-engineering checklist (`references/overengineering-checklist.md`), each rated `safe` (provably behaviour-preserving) or `risky`; the fix agent applies them, preserving behaviour exactly. A `pass` verdict means the code is already simple enough — trivial/nitpick-level ideas are returned with the result but not applied, so the loop ends; `fail` sends the recommendations to the fix agent. The `design` context block is AUTHORITATIVE: neither agent ever proposes/applies a simplification that contradicts the plan's architecture or engineering needs (module boundaries, layers, interfaces, data shapes, testability, observability, security, error handling, performance) — design-mandated machinery (a layer, interface, config flag, guard, error path) is not over-engineering, and the checklist applies only where the design is silent. Cap at `maxRounds` (default 8).

### uniterra-review

Adversarial review — usable standalone, no plan required. Assemble a goal + context (requirements / design / acceptance) + task, then a `workflow` loops review → fix → re-review: a single review agent (review and repro merged) returns a verdict (`pass` | `fail`) plus findings graded critical / high / medium / low, covering correctness AND security (`references/security-checklist.md`), and CONFIRMS each finding before reporting it by writing a failing regression test in the repo's conventional test location with a descriptive invariant-based name (never a finding id) — only confirmed findings are reported and unconfirmed ones are dropped, and it never reports low-value non-logic issues (stale docs/comments, formatting/style nits), focusing on the code logic itself; the fix agent repairs only the confirmed findings. A `pass` verdict means the change is ready — only confirmed low-severity non-blocking findings remain, returned with the result but not fixed, so the loop ends; `fail` sends the confirmed findings to fix. Cap at `maxRounds` (default 8).

### uniterra-pbt-debugging

Invariant-first debugging — turns a bug into a machine-search problem.

1. **Read and search the business logic under investigation** — trace inputs, pure functions, state transitions; find the invariants the code must satisfy.
2. **Define the logic as invariants and reproduce via PBT** — generate arbitrary inputs, assert the property (fast-check); it must FAIL against current code — the counterexample is the reproduction; refine until it fails; keep it as the red phase.
3. **Fix the root cause, then complete unit/regression tests** — PBT goes green; unit tests pin the concrete case; full suite green.

Rules: no code changes before a failing reproduction; prefer properties over unit tests; fall back to the generic evidence-driven loop for non-reducible bugs (I/O, timing) but still add a regression test.

## Dependencies

- Outbound: node builtins only (fs/path); parses YAML frontmatter of SKILL.md in-process.
- Inbound: `packages/uniterra-desktop` (provisions at startup); dsh runtime (bundled provider via `DSH_BUNDLED_SKILL_DIR`).

## Patterns & Gotchas

- `SKILL_NAMES` is the single manifest driving provisioning + listing — add a skill there and to `src/skills/<name>/SKILL.md`; retire a skill via `RETIRED_SKILL_NAMES` (its provisioned copy is then removed).
- Skill frontmatter `description:` is parsed as a folded YAML field (continuation lines joined).

## How to Update

- New/renamed skill → edit `SKILL_NAMES`, add the skill dir, run `pnpm run build` (copy-skills refreshes `dist/skills/`; deleted skills stop shipping).
- Retired skill → add to `RETIRED_SKILL_NAMES` so already-provisioned copies are removed.
- Skill content changed → the skill dir itself; no code change needed.

## Find It Fast

```bash
grep -n 'SKILL_NAMES' packages/uniterra-skills/src/index.ts   # registry manifest
ls packages/uniterra-skills/src/skills/                       # bundled skills
```
