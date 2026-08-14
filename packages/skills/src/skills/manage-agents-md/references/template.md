# AGENTS.md Template

The canonical structure. Replace bracketed text with project-specific content.
Target: ~100 lines. If you exceed 150, move detailed content to `docs/` and link to it.

```markdown
# [Project Name] — [one-line description]

## Build & Test

- `[exact build command with flags]` — [what it does]
- `[exact test command with flags]` — [what it does, e.g. "full suite"]
- `[single-test command]` — [e.g. "run one test file"]
- `[lint command]` — [what it checks]
- `[type-check command]` — [what it checks]
- [Any pre-commit hooks or CI requirements]

## Tech Stack

- **Language**: [e.g. Python 3.12, TypeScript 5.4, Rust 1.80]
- **Framework**: [e.g. FastAPI 0.115, Next.js 14 App Router]
- **Package manager**: [e.g. uv, pnpm 9.x, cargo] — never [alternatives to avoid]
- **Database**: [e.g. PostgreSQL 16 via SQLAlchemy, SQLite via better-sqlite3]
- **Testing**: [e.g. pytest 8.x + pytest-cov, Vitest + Playwright]
- **Lint/Format**: [e.g. ruff + mypy --strict, Biome, eslint + prettier]

## Project Structure

- `[dir]/` — [what lives here, what it's responsible for]
- `[dir]/` — [what lives here]
- `[dir]/` — [what lives here, e.g. "shared utilities — no framework imports"]
- `tests/` — [test organization pattern]
- [Key files worth calling out: config entry points, env validation, migration scripts]

## Key Constraints

- [Non-obvious rule 1 — something an agent would guess wrong]
- [Non-obvious rule 2 — tooling constraint like "use bun, not npm"]
- [Architectural invariant — e.g. "shared/ must remain framework-agnostic"]
- [API pattern — e.g. "all endpoints return { data, error } envelope"]

## Testing

- [How to run the full suite: exact command]
- [How to run a single test: exact command]
- [Coverage expectations: e.g. "80% minimum, enforced in CI"]
- [Mock policy: e.g. "mock external APIs, never mock the database"]

## Git Workflow

- [Branch naming convention: e.g. "feature/*, fix/*, chore/*"]
- [Commit message format: e.g. "conventional commits: feat:, fix:, chore:"]
- [PR requirements: e.g. "squash merge, one approval required"]

## Documentation

- `docs/[area]/` — [what kind of docs live here]
- `docs/[area]/` — [what kind of docs live here]
- [Any doc conventions: BDD format, trace-to-source requirements, etc.]

## Boundaries

**Always:**
- [Thing the agent must always do — e.g. "Run tests before committing"]
- [Thing the agent must always do — e.g. "Add tests for changed code"]

**Ask first:**
- [Risky change requiring approval — e.g. "Adding new dependencies"]
- [Risky change requiring approval — e.g. "Modifying database schema"]
- [Risky change requiring approval — e.g. "Changing CI/CD config"]

**Never:**
- [Hard block — e.g. "Commit .env files or secrets"]
- [Hard block — e.g. "Edit generated/ directory"]
- [Hard block — e.g. "Bypass the rate limiter or auth middleware"]
```

## Section Notes

### Build & Test
- **Most important section.** Put it first. Agents reference these commands constantly.
- Include flags: `pytest -v` not `pytest`, `pnpm test --run` not `pnpm test`.
- Include the command to run a single test, not just the full suite.
- If there's a specific order (lint → type-check → test), document it.

### Tech Stack
- Include versions. "React 18" not "React". Agents use this to pick correct APIs.
- Call out the package manager explicitly — this is the #1 thing agents guess wrong.

### Project Structure
- Map directories to responsibilities, not just descriptions.
- "`src/api/` — route handlers (thin, delegate to services)" beats "`src/api/` — API code".
- Mark directories that are generated or off-limits.

### Key Constraints
- Only include what an agent CANNOT infer from config files.
- "Use named exports only" is a good convention. "Use TypeScript" is not — the tsconfig already says that.
- "All git commands use list args, no shell=True" is a good constraint. "Write tests" is too vague.

### Testing
- Separate from Build & Test if the testing instructions are substantial.
- Include the mock policy explicitly: "mock external APIs, never mock the database."
- Mention coverage expectations if enforced in CI.

### Git Workflow
- Keep brief — one line per convention. Link to CONTRIBUTING.md for details.
- Only include rules that differ from defaults (e.g. squash-merge-only, conventional commits).

### Boundaries
- Three tiers are proven effective (from GitHub's 2,500+ repo analysis).
- The "Never" tier is the highest-value — prevents catastrophic mistakes.
- Make boundaries specific and checkable: "Never edit `generated/`" not "Be careful with generated code".

### What to Omit
- No task-specific instructions → that's a skill
- No architecture deep-dives → that's `docs/architecture.md`
- No workflow tutorials → that's `docs/workflows.md`
- No @import directives → AGENTS.md doesn't support them
- No YAML frontmatter → unless in `.github/agents/` for Copilot custom agents
