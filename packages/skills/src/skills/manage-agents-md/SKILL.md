---
name: manage-agents-md
description: >-
  Create, audit, update, and maintain project specification files that
  guide AI coding agents: AGENTS.md, CLAUDE.md, .cursorrules,
  .windsurfrules, and similar agent context files. Use when the user
  asks to create, review, improve, or audit agent spec files, wants to
  manage project convention files, or asks about coding rules for AI
  agents (項目規範文件, agent context, coding guidelines, project rules).
  NOT for: README.md, CONTRIBUTING.md, general project documentation, or
  writing docs/ content.

---

# AGENTS.md Manager

## Goal

Produce and maintain AGENTS.md files that give AI coding agents exactly the
project context they need — no more. The file should be a ~100-line orientation
map. Quality is measured by whether an agent reading it for the first time can
build, test, and follow conventions without guessing.

## Acceptance Criteria

- Created file passes all checks in `references/audit-checklist.md`
- Audit produces a structured report with pass/fail per item and fix suggestions
- Updated file has zero stale commands (every listed command runs successfully)
- Every convention in the file is falsifiable (checkable against code)

## Core Principles

**Three-layer separation.** AGENTS.md is project orientation, not documentation:

| Layer | What it contains | Where it lives |
|-------|-----------------|----------------|
| Orientation | Build/test commands, non-obvious constraints, directory map | `AGENTS.md` (~100 lines) |
| Knowledge | Architecture details, convention deep-dives, workflow guides | `docs/` directory |
| Task | How to perform a specific type of work | Agent Skills (SKILL.md) |

AGENTS.md points to `docs/` — it does not inline the knowledge.

**ETH Zurich threshold.** A 138-repo study found human-curated AGENTS.md files
provide only +4% success gain while adding 20%+ inference cost. Every line must
earn its place. For each line ask: "Could a frontier model infer this from the
codebase alone?" If yes → remove.

**Six core areas.** Analysis of 2,500+ repos identified the sections that
correlate with agent success: (1) Build & Test commands with flags, (2) Tech
stack with versions, (3) Project structure as responsibility map, (4) Code
conventions that differ from defaults, (5) Testing instructions including mock
policy, (6) Three-tier boundaries (Always / Ask first / Never).

## Workflows

### Workflow A: Create from Scratch

1. **Scan the project** — read the package manifest, linter config, test config,
   CI config, and top-level directory listing
2. **Identify content** for each of the six core areas above
3. **Write** following the structure in `references/template.md`
4. **Self-audit** using the checklist in `references/audit-checklist.md`
5. **Run every command** listed in the file (drift-check your own work).
   Apply the drift check safety gate from Workflow B.
6. **Present** to the user for review

### Workflow B: Audit Existing

0. **Precondition** — verify the file exists at `./AGENTS.md`, is non-empty,
   and is readable. If missing → suggest Workflow A. If empty or binary → abort
   with a specific message.
1. Load `references/audit-checklist.md`. Run every check: structural (location,
   size, sections), content quality (9 criteria with pass/fail examples), drift
   (run every command — see safety gate below), and ETH Zurich threshold.
2. Produce a structured report with per-item pass/fail and specific fix
   suggestions.
3. If issues were found and fixed, re-run the audit to confirm resolution.

**Drift check safety gate:** Before executing any command from the AGENTS.md:
- Skip commands matching destructive patterns (`rm -rf`, `drop`, `reset`,
  `prune`, `clean --force`). Flag them as "skipped — destructive" in the report.
- For commands that modify the environment (`source`, `export`, `nvm use`),
  note them but don't execute — they can't be reliably tested in a sub-shell.
- If a command fails, check whether the project environment is set up (venv
  active? dependencies installed?). Report environment failures separately from
  stale-command failures.

### Workflow C: Update After Changes

1. Identify what changed (package manager? test framework? directory layout?)
2. Update only the affected sections
3. Verify no other sections reference the old state
4. Re-run the drift check

## Gotchas

- **Stale commands are the #1 failure mode.** Package managers change, test
  frameworks migrate, directories get renamed. Always run every command in the
  file during audit. A command that fails means the file is wrong — but first
  verify the project environment is set up (venv active, dependencies
  installed). Distinguish "command is stale" from "environment not configured."
- **Claude Code does NOT read AGENTS.md natively** (as of mid-2026). If a
  project has both files, check for duplication. The fix: `CLAUDE.md` with
  `@AGENTS.md` as first line, then Claude-specific rules only. Most repos with
  both files have them wrong — cross-platform rules duplicated and drifting.
- **Monorepo: Copilot ≠ Codex.** Copilot uses nearest-ancestor-only (package
  files must be self-contained). Codex concatenates root-to-CWD (package files
  can assume root context). Make each package AGENTS.md self-contained to work
  with both.
- **Token budget is real.** The ETH Zurich study found context files increase
  inference cost 20%+. Remove anything inferable. "We use TypeScript" is
  already in tsconfig.json — delete it. Keep only what's non-obvious.
- **Vague instructions hurt more than they help.** "Write clean code" and
  "Follow best practices" waste tokens with zero behavioral impact. Replace
  with falsifiable rules: "Use named exports only; no default exports."

## Quality Gates

Before presenting any created/updated AGENTS.md:

1. **Run every command in the file** — if any fail, the file is wrong
2. **Count lines** — warn if >150, strongly recommend refactoring if >200
3. **Self-audit** — run the full `references/audit-checklist.md` against the result

## References

Load on demand, not upfront. Each is needed only during its workflow.

- `references/template.md` — Canonical structure with annotated section notes.
  Load during **Workflow A step 3**.
- `references/audit-checklist.md` — Full checklist: structural, 9 content
  quality criteria (with pass/fail examples), drift check, ETH Zurich threshold,
  output format. Load during **Workflow B** or **Quality Gate 3**.
- `references/community-practices.md` — Research bibliography: 8 sources, key
  statistics, 10 anti-patterns, AGENTS.md vs CLAUDE.md layering, monorepo
  patterns. Load for **background context** when the agent needs deeper
  understanding of why certain rules exist.
