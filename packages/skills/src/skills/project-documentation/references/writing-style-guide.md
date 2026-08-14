# Agent-First Writing Style Guide

Documentation written for AI coding agents follows different rules than
documentation written for humans. This guide codifies the conventions used
by leading projects (agentic-docs, codedocs, CodeWiki) and research
(Ability.ai's horizontal/vertical strategy, IBM's AI doc practices).

---

## The Golden Rule

> **Write for agents first, humans second.** An agent reading this documentation
> should be able to find what it needs, understand the structure, and make changes
> without exploratory grepping. If a human also benefits, that's a bonus.

---

## Core Rules

### Rule 1: No Introductions

Agents don't need a preamble. Jump straight to the content.

| ❌ Bad | ✅ Good |
|--------|---------|
| "In this document, we will explore the architecture of the system, covering its main components, data flow, and key design decisions. This will help you understand..." | "## Architecture" |
| "Welcome to the documentation! This guide is designed to help developers..." | (Delete — start with the first section) |
| "The purpose of this document is to provide a comprehensive overview..." | (Delete — the heading IS the purpose) |

### Rule 2: Tables Over Prose

Agents parse tables faster than prose. Use tables for catalogs, lookups, and comparisons.

| ❌ Bad | ✅ Good |
|--------|---------|
| "The application exposes several endpoints. The health check endpoint returns the status of the service. The login endpoint accepts an email and password and returns a JWT token..." | Table: `| GET | /health | None | {status} | Health check |` |
| 3 paragraphs describing module responsibilities | 1 table: `| Module | Purpose | Key Exports |` |

### Rule 3: Short Entries (≤ 5 Lines)

If a module description exceeds ~5 lines, it's too long. Split it into a table
or link to a dedicated file.

| ❌ Bad | ✅ Good |
|--------|---------|
| 15-line prose description of the auth module | "Handles user authentication: login, logout, token refresh, password reset. See `src/auth/` for implementation." |
| Verbose function explanation | `login(email, password) -> Token` — Authenticate user, return JWT. |

### Rule 4: Structural Maps, Not File Listings

Instead of listing files alphabetically, organise by task ("I want to X → look here").

| ❌ Bad | ✅ Good |
|--------|---------|
| ```src/api/routes.py src/api/middleware.py src/services/auth.py src/models/user.py``` | `| I want to... | Look here |` |
| Alphabetical file tree | Task-oriented grouping |

### Rule 5: No Fluff Words

Strip filler phrases. Agents don't need politeness or emphasis markers.

| ❌ Bad | ✅ Good |
|--------|---------|
| "It's important to note that..." | Just state the fact. |
| "Please remember to..." | Delete "Please remember to" |
| "You should always..." | Use imperative: "Always..." |
| "It is worth mentioning that..." | Delete entirely |
| "As you can see..." | Delete entirely |
| "Needless to say..." | Delete entirely |
| "Obviously..." | If it's obvious, don't say it |

### Rule 6: One Home Per Fact

Every fact, concept, or instruction lives in exactly ONE file. Cross-reference
with relative links — never copy-paste.

| ❌ Bad | ✅ Good |
|--------|---------|
| Auth setup described in README.md, architecture.md, AND setup.md | Auth setup in `docs/setup.md`; others link: "See [Setup](setup.md#auth)" |
| Same API endpoint table in two files | One canonical table in `api-reference.md`; modules link to it |

### Rule 7: Source Links With Line Numbers

When referencing code, link to the source file with optional line numbers.

| ❌ Bad | ✅ Good |
|--------|---------|
| "The auth module handles authentication" | "Auth module (`src/auth/index.ts:1-50`): JWT middleware + login/logout" |
| "The User model defines the user entity" | "`User` model (`src/models/user.py:15-45`): id, email, password_hash, role" |

### Rule 8: Imperative Voice

Use direct commands, not suggestions or passive voice.

| ❌ Bad | ✅ Good |
|--------|---------|
| "Tests can be run using the following command..." | "Run tests: `pytest -v`" |
| "The database should be migrated before starting" | "Migrate database: `alembic upgrade head`" |
| "It is recommended to use environment variables" | "Use environment variables. See `.env.example`." |

### Rule 9: No Emojis

Agents don't benefit from emojis. They add token cost without information value.

| ❌ Bad | ✅ Good |
|--------|---------|
| "🚀 Getting Started" | "## Getting Started" |
| "✅ Tests passing" | "Tests passing" |
| "⚠️ Important: ..." | "**Important:** ..." |

### Rule 10: Every File Ends With Utility Section

Each doc file should end with one of:
- **"How to update"** — tells a future agent exactly what to edit when code changes
- **"Find it fast"** — grep snippets to quickly verify a claim against the source

```markdown
## How to Update
- New endpoint added? → Add row to endpoint table + update count
- Module renamed? → Update directory map + cross-references
- New dependency? → Add to tech stack table with version

## Find It Fast
```bash
grep -r "class.*Model" src/models/        # All data models
grep -r "@router\." src/api/              # All API routes
```
```

---

## Lookup Table Pattern

The highest-value pattern for agents. Every `README.md` hub should have one:

```markdown
| I want to... | Read... |
|-------------|---------|
| Understand the system design | [architecture.md](architecture.md) |
| Find a specific API endpoint | [api-reference.md](api-reference.md) |
| Know what technologies we use | [tech-stack.md](tech-stack.md) |
| Set up the project from scratch | [setup.md](setup.md) |
| Understand the auth module | [modules/auth.md](modules/auth.md) |
| Run the tests | [testing.md](testing.md) |
| Add a new feature | [workflows.md](workflows.md) |
| Know our code conventions | [conventions.md](conventions.md) |
| See the database schema | [data-models.md](data-models.md) |
| Find where code lives | [project-structure.md](project-structure.md) |
```

---

## Anti-Patterns to Avoid

1. **Duplicated content** — same fact in README.md and architecture.md. Pick one home.
2. **Stale diagrams** — Mermaid doesn't match the code. Fix in same commit as code change.
3. **Narrative architecture** — "First, the system was designed as a monolith, then we split..." — agents need current state, not history.
4. **Human-only assumptions** — "as you know", "obviously", "clearly". Be explicit.
5. **Vague instructions** — "run the tests" vs `pytest -v tests/`.
6. **Unlinked orphan docs** — every doc file must appear in the hub README.md index.
7. **Over-documentation** — if a fact is inferable from code (e.g., "uses Python"), don't document it unless there's a non-obvious reason.
