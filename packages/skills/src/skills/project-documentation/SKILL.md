---
name: project-documentation
description: >-
  Generate a structured multi-file docs/ tree from any codebase:
  architecture diagrams, per-module deep dives, API reference, conventions,
  data models, setup, testing, and workflow recipes — with Mermaid diagrams
  and incremental git-diff updates. Use when the user asks to document a
  project, generate documentation, write docs, or create project wiki
  (寫文檔, 生成文檔, 項目文檔, documentation). NOT for: single README
  updates, one-line summaries, AGENTS.md/CLAUDE.md generation, or trivial
  single-file scripts.
---

## Goal

Transform any codebase into a structured `docs/` tree where every fact has
exactly one home, every diagram matches the code, and every cross-reference
resolves. Output is agent-first — tables over prose, structural maps over
narrative. Downstream agents read these docs instead of re-grepping the repo.
The project root `README.md` stays in sync — it remains the front door,
linking to `docs/` and reflecting the current project state.

## Acceptance Criteria

- Tech stack auto-detected and verified against actual imports
- Complete `docs/` tree: architecture, modules, API, conventions, data, setup, testing, workflows
- Mermaid diagrams (C4 context + container minimum) match current code
- All cross-references resolve; hub README indexes every file
- Project root `README.md` updated: links to `docs/`, reflects current state
- Incremental mode (when git available): `git diff` → update only affected docs
- Verification audit passes: coverage, links, freshness, quality, diagrams

## Pre-Flight

Before starting any phase, check these preconditions:

1. **Verify skill files exist.** Confirm `references/*.md` and `templates/*.tmpl`
   are present. If any are missing, report the gap and abort — do not guess formats.
2. **Check git availability.** Run `git rev-parse --is-inside-work-tree 2>/dev/null`.
   If git is unavailable or the project is not a repo: disable incremental mode,
   freshness audit, and `git diff`-based operations. Fall back to full generation.
3. **Detect existing docs/ format.** If `docs/` exists, check for format markers:
   - Our format: `docs/README.md` with a "Document Index" or "I want to..." table
   - Incompatible format: `conf.py`, `index.rst` (Sphinx), `mkdocs.yml`, `docusaurus.config.js`
   - Unknown: none of the above
   
   Decision: our format → incremental update. Incompatible/unknown → warn the user,
   offer `docs-agent/` as an alternative output directory. Never silently mix formats.
4. **Choose workflow path.** If `docs/` exists and is our format → Incremental
   Update. Otherwise → full 4-phase workflow below.

## Core Principles

1. **One home per fact.** Cross-reference, never duplicate. If a fact appears in two files, pick one and link.
2. **Verify config against imports.** A `pyproject.toml` listing both Flask and FastAPI needs source-level confirmation — never trust manifests alone.
3. **Agent-first, not human-first.** Tables, structural maps, imperative voice, ≤5-line entries. No introductions, no fluff, no emojis.
4. **Incremental when possible.** When docs exist (our format + git available), update only affected sections. Full regeneration is a last resort.
5. **Diagrams ship with code.** Every Mermaid diagram updates in the same commit as the structural change it reflects.
6. **README stays in sync.** The root `README.md` is the project's front door; `docs/README.md` is the docs hub. Whenever docs change, update the root README's docs link and any facts it duplicates — never let the two drift.

## Workflow

Skip to [Incremental Update](#incremental-update) if pre-flight chose that path.

### Phase 1: SCAN — Inventory

Read config files, entry points, and directory tree (top 2 levels from repo root).
Detect the tech stack using `references/tech-stack-detection.md`.

> **Fallback: no config files.** If no standard config is found (no pyproject.toml,
> package.json, etc.), detect the language via shebangs, file extensions, and
> directory heuristics. Generate a minimal `tech-stack.md` with `[INFERRED]` on
> every row. For unparseable projects, reduce the document set: skip
> `api-reference.md` and `data-models.md` if no APIs or models are detected.

Produce a structured inventory (in memory) covering: tech stack, module
boundaries, external dependencies (packages + services + infrastructure),
config surface, and existing docs coverage.

### Phase 2: ANALYZE — Deep Read

A **module** is a top-level source directory containing ≥2 files with business
logic, OR a logical domain concept (auth, users, payments) that spans files.
In flat projects with no clear boundaries, collapse all modules into a single
`docs/modules/overview.md` with a per-file table.

For each module: extract public API (exported names — in Python, names without
leading underscore, or `__all__` if present), trace imports (outbound via
`grep -rn '^from|^import'` + inbound via `grep -rl 'from <module>'` → build
a dependency graph), capture recurring patterns that differ from language defaults,
and note architectural decisions. Flag any rationale not explicitly documented
in ADRs, comments, or commit messages as `[INFERRED]`.

> **Gotcha:** Never present an inferred rationale as fact. `[INFERRED]` is
> mandatory when the actual decision reason isn't documented. If ALL decisions
> are inferred, the architecture decisions table should note this explicitly.

### Phase 3: GENERATE — Write

Generate files in **strict dependency order** (later files reference earlier ones):

| Order | File | Depends On |
|-------|------|------------|
| 1 | `tech-stack.md` | — |
| 2 | `project-structure.md` | — |
| 3 | `architecture.md` | tech-stack, project-structure |
| 4 | `conventions.md` | — |
| 5 | `modules/*.md` | project-structure, architecture |
| 6 | `api-reference.md` | modules |
| 7 | `data-models.md` | modules |
| 8 | `setup.md` | tech-stack |
| 9 | `testing.md` | tech-stack, conventions |
| 10 | `workflows.md` | modules, conventions |
| 11 | `README.md` (docs hub) | **everything — must be last** |
| 12 | root `README.md` | docs hub, setup, tech-stack |

For each file's output contract, follow `references/document-types.md`.
For writing conventions, follow `references/writing-style-guide.md`.
Templates in `templates/` are structural guides — use them to understand the
expected sections and table shapes, then write content from your analysis.
Remove any section that doesn't apply to the project (e.g., skip "Pagination"
if the API doesn't paginate). After generation, grep `docs/` for `{{` —
any remaining placeholders are a bug.

Skip document types that don't apply: no HTTP routes → skip `api-reference.md`;
no database → skip `data-models.md`; no tests → note this in `testing.md`
rather than skipping it.

> **Gotcha:** `docs/README.md` is the hub that indexes every other file.
> Generating it before the indexed files exist produces broken links.
> Always generate it LAST.

**Root README (step 12):** After the docs tree is complete, update the project
root `README.md`. It must:
- Link to the docs hub: `[Documentation](docs/README.md)`
- Reflect the current project state: name, one-line description, tech stack
  highlights, install/run commands, test command — pulled from `setup.md` and
  `tech-stack.md`
- Not duplicate deep content (architecture diagrams, module lists) — link into
  `docs/` instead, keeping "one home per fact"

If no root `README.md` exists, create one. If it exists, update the stale
sections rather than rewriting wholesale. If the project deliberately uses a
different entry doc (e.g. `docs/index.html` in a static site), update that
instead and note it in the audit report.

### Phase 4: VERIFY — Audit

Run the audit from `references/audit-checklist.md`: Coverage, Links, Freshness
(when git available), Quality, Diagrams. Produce a composite report with
PASS/FAIL per dimension. Every failure must include a concrete fix suggestion.
Apply fixes for clear issues, then re-audit. Report issues you can't fix
(missing external validation tools, destructive commands) as `[UNABLE TO VERIFY]`.

> **Safety:** Never run install, Docker, or database commands during audit.
> Check commands with `--help` or `--dry-run` first. The audit verifies
> documentation correctness — it does not modify the running system.

---

## Incremental Update

Run this workflow when `docs/` exists and is our format.

1. `git diff --name-only <baseline>..HEAD` (or unstaged diff)
2. Map changes to affected docs using the dependency graph from Phase 2:
   - `src/<module>/` changed → `docs/modules/<module>.md`
   - Data model changed → `docs/data-models.md`
   - Route changed → `docs/api-reference.md`
   - New/removed dependency → `docs/tech-stack.md`
   - Directory restructured → `docs/project-structure.md`
3. Update ONLY affected sections. Re-read changed source, update doc entries —
   do not touch unrelated sections.
4. Sync the root `README.md`: if install/run/test commands, tech stack, or
   project description changed, reflect that in the root README (per Phase 3
   step 12). Confirm the `docs/` link still resolves.
5. Focused re-audit: links on updated files, freshness on changed modules,
   root README vs docs consistency.

**Without git:** fall back to full regeneration with `[UNABLE TO VERIFY — no git]`
on all freshness checks.

---

## Gotchas

- **Config ≠ truth.** Always verify framework claims by reading actual imports.
  A manifest listing three web frameworks proves nothing about which one is used.
- **Monorepo detection first.** Before assuming single-project layout, check for
  workspace configs (`pnpm-workspace.yaml`, `workspaces` in `package.json`,
  multiple `pyproject.toml` files). Monorepos need per-package `docs/`.
- **Suppress human-first instincts.** The agent's default is human-friendly prose
  (introductions, narrative, politeness). Actively suppress this. Every paragraph
  over 5 lines without a table or list is a violation.
- **`[INFERRED]` is mandatory.** Any architectural rationale, design intent, or
  decision history not explicitly documented in the codebase must carry this tag.
  Presenting inference as fact is the #1 documentation hallucination.
- **Generation order is non-negotiable.** `README.md` last. Cross-references break
  if you write the index before the indexed files exist.
- **Root README ≠ docs hub.** `docs/README.md` indexes the docs tree; the root
  `README.md` is the project's front door. Both must be updated — a root README
  that describes an old stack or misses the docs link is a stale-docs failure
  even if `docs/` itself is perfect.
- **Never silently mix doc formats.** If `docs/` exists from another generator
  (Sphinx, MkDocs, Docusaurus), don't merge. Offer `docs-agent/` as an alternative
  or ask the user. Merging breaks both formats.
- **Templates are guides, not fill-in-the-blank forms.** Use them to understand
  what sections and table shapes each document needs. Write from analysis, not
  by literal placeholder replacement. Remove inapplicable sections.

## References

- `references/document-types.md` — Output format contract for all 12 document types (11 docs/ files + root README)
- `references/tech-stack-detection.md` — Detection matrices for 10 languages, databases, infrastructure
- `references/writing-style-guide.md` — Agent-first writing rules (10 rules with bad/good examples)
- `references/audit-checklist.md` — 5-dimension verification protocol with report formats
