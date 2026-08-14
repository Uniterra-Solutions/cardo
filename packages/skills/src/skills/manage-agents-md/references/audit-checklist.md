# AGENTS.md Audit Checklist

Full audit checklist with concrete pass/fail examples. Run every item.

## 1. Location & Naming

| Check | Pass | Fail |
|-------|------|------|
| File at repo root `./AGENTS.md` | `/AGENTS.md` exists | `docs/AGENTS.md`, `agents.md`, `AGENTS.MD` |
| Exact case `AGENTS.md` | `AGENTS.md` | `agents.md`, `Agents.md` |

## 2. Size

| Check | Pass | Fail |
|-------|------|------|
| Under 150 lines (soft) | 80 lines | 300 lines |
| Under 32KB (Codex hard cap) | 4KB | 40KB |

## 3. Core Sections (need ≥4 of 6)

| Section | What to look for |
|---------|-----------------|
| Build & Test Commands | Exact commands with flags. Not "run the tests". |
| Tech Stack / Project Overview | Language + framework + versions. Not "web app". |
| Project Structure | Directory → responsibility map. Not just a file listing. |
| Code Style / Conventions | Rules that differ from defaults. Not "use ESLint". |
| Testing Instructions | Framework, how to run single test, mock policy. |
| Boundaries | At minimum one "Never" rule. Ideally Always/Ask/Never. |

## 4. Content Quality (score each)

### 4.1 Commands are copy-pasteable
- ✅ PASS: `` `uv run pytest -v --cov=src tests/` ``
- ❌ FAIL: "Run the test suite"
- ❌ FAIL: "Tests use pytest" (states the tool, not the command)

### 4.2 Stack is specific with versions
- ✅ PASS: "Python 3.12 + FastAPI 0.115, PostgreSQL 16 via SQLAlchemy 2.0"
- ❌ FAIL: "Python backend"
- ❌ FAIL: "React project" (missing version, missing framework details)

### 4.3 Conventions are falsifiable
- ✅ PASS: "Use named exports only; no default exports except in page files"
- ✅ PASS: "All API routes return `{ data, error }` envelopes"
- ✅ PASS: "File names: kebab-case (`user-profile.ts`, not `UserProfile.ts`)"
- ❌ FAIL: "Write clean code"
- ❌ FAIL: "Follow best practices"
- ❌ FAIL: "Keep things simple"

### 4.4 Boundaries have clear tiers
- ✅ PASS: "Never: commit .env files, edit generated/, bypass auth middleware"
- ✅ PASS: "Ask first: adding dependencies, modifying DB schema, changing CI config"
- ✅ PASS: "Always: run tests before committing, add tests for new code"
- ❌ FAIL: No boundaries section at all
- ❌ FAIL: "Be careful with production configs" (vague, no tier)

### 4.5 No vague instructions
- ❌ FAIL: "Write clean code", "Be careful", "Follow best practices", "Keep it simple"
- ✅ PASS: If advice isn't falsifiable, it shouldn't be in the file

### 4.6 Not duplicating inferable info
The agent can already discover language choice, linter, and package manager from
config files. Don't repeat these as standalone facts. However, **the Tech Stack
section is exempt** — explicitly listing versions there helps agents pick correct
APIs and is expected. The rule targets vague restatements elsewhere (e.g., "We
use TypeScript" on its own line outside Tech Stack).

Examples of what to flag:
- "This project uses ESLint" (already in .eslintrc) → flag
- "We use pnpm as package manager" (already in pnpm-lock.yaml) → flag
- "Python 3.12 + FastAPI 0.115" in the Tech Stack section → keep (canonical agent reference)

Exception: if the tooling has non-obvious behavior, document THAT.
"We use pnpm workspaces" is inferable; "Never run `pnpm install` at the root — use `pnpm install --filter <pkg>`" is not.

### 4.7 Pointers, not encyclopedia
- ✅ PASS: "Auth flow: see `docs/auth.md`"
- ❌ FAIL: Inlining 50 lines of auth flow explanation
- ❌ FAIL: Copying architecture docs into the file

### 4.8 No tool-specific syntax
- ❌ FAIL: `@import docs/style-guide.md` (Claude Code only)
- ❌ FAIL: YAML frontmatter in root AGENTS.md (only valid in `.github/agents/` for Copilot)
- ❌ FAIL: Glob patterns or path-scoped rules
- ✅ PASS: Plain markdown only

### 4.9 Security gotchas present
- ✅ PASS: "Never commit .env files or secrets"
- ✅ PASS: "Never read API keys from disk in test files"
- ❌ FAIL: No security guidance at all

## 5. Drift Check (operational)

Run every command listed in the file and verify they still work:

**Safety gate — before executing:**
- Skip destructive commands: `rm -rf`, `drop`, `reset`, `prune`, `clean --force`.
  Flag as "skipped — destructive."
- Skip environment-modifying commands: `source`, `export`, `nvm use`.
  Flag as "skipped — environment modifier."
- For all others:

```
# For each command block in the file:
$ [command from AGENTS.md]
# If exit code != 0 → first verify the project environment is set up
#   (venv active? dependencies installed? correct runtime version?)
# If environment is correct and command still fails → flag as stale
# If command references a file/dir that no longer exists → flag
```

**Environment vs. staleness:** A failing command may mean the host lacks the
project's runtime or dependencies, not that the file is wrong. Report these
separately: "command failed — environment may not be configured" vs.
"command failed — file is stale."

Common drift patterns:
- Package manager changed (npm → pnpm) but AGENTS.md still says npm
- Test framework migrated (jest → vitest) but commands reference old framework
- Directories renamed or restructured
- Pre-commit hooks added/removed but AGENTS.md not updated
- Python version bumped but AGENTS.md still says old version

## 6. ETH Zurich Threshold

For each line in the file, ask: "Could a frontier model infer this from the codebase alone?"

If yes → the line adds token cost without benefit. Remove or replace with the non-inferable version.

| Inferable (remove) | Non-inferable (keep) |
|-------------------|---------------------|
| "This project uses TypeScript" | "Use TypeScript strict mode — we have `strict: true` in tsconfig" |
| "Tests use pytest" | "Run `pytest -v --cov=src --cov-report=term-missing` — coverage below 80% fails CI" |
| "We use ESLint for linting" | "Run `eslint --fix` before committing — pre-commit hook enforces this" |
| "The project is a REST API" | "All endpoints return `{ data, error }` envelopes — never raw objects" |

## Output Format

```
## AGENTS.md Audit: [project-name]

### Structural
- [x] Location: ./AGENTS.md
- [x] Case: exact match
- [ ] Size: 245 lines ⚠️ (recommend <150)
- [x] Sections: 5/6 core sections present

### Content Quality
- [x] Commands copy-pasteable
- [x] Stack specific with versions
- [ ] Conventions falsifiable ⚠️ — "write clean code" on line 42 is vague
- [x] Boundaries three-tier
- [x] No vague instructions (except line 42)
- [ ] Duplicating inferable info ⚠️ — lines 15-18 restate tsconfig strict settings
- [x] Pointers not encyclopedia
- [x] No tool-specific syntax
- [x] Security gotchas present

### Drift
- [x] `uv run pytest -v` — passes
- [x] `uv run ruff check .` — passes
- [ ] `npm run build` — FAILS (project migrated to pnpm) 🔴

### ETH Zurich Threshold
- 2 lines flagged as inferable — suggest removal

### Summary
3 issues found: 1 stale command, 1 vague convention, 2 inferable lines.
Recommend: fix stale command, rewrite line 42, remove lines 15-18.
```
