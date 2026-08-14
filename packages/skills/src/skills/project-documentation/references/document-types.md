# Document Types — Full Specification

Each document type in the `docs/` tree has a specific purpose, audience, and structure.
This reference defines the contract for each type so the generator produces consistent,
complete output regardless of the project.

---

## Document Type Catalog

### 1. `docs/README.md` — Navigation Hub

**Purpose:** Entry point for anyone (agent or human) opening the docs. Answers
"I want to X — where do I look?"

**Structure:**
- Project summary (2-3 sentences — what, why, for whom)
- Quick links: Setup, Architecture Diagram, API Reference
- "I want to..." lookup table
- Full document index (link to every file in `docs/`)
- Link back to project root `README.md`

**When to update:** Whenever a new doc file is added or removed from `docs/`.

### 2. `docs/architecture.md` — System Design

**Purpose:** Visual and textual description of the system's structure and data flow.

**Structure:**
- System Context diagram (C4 Level 1: Mermaid `graph TD`)
  - The system, users, and external services
- Container diagram (C4 Level 2: Mermaid `graph TD`)
  - Web app, API server, database, cache, queue, etc.
- Data flow walkthrough: how a request travels through the system
- Key architectural decisions:
  ```markdown
  | Decision | Rationale | Status |
  |----------|-----------|--------|
  | Use JWT for auth | Stateless, works across services | Active |
  ```
  Mark inferred rationale with `[INFERRED]`.
- Deployment topology (Docker Compose or orchestration overview, if detected)

**When to update:** Any structural change — new service, new external dependency,
changed data flow, new architectural decision.

### 3. `docs/tech-stack.md` — Technology Inventory

**Purpose:** Complete inventory of languages, frameworks, and tools with versions.

**Structure:**
```markdown
| Component | Version | Purpose | Notes |
|-----------|---------|---------|-------|
| Python | 3.12 | Runtime | |
| FastAPI | 0.115 | Web framework | |
| SQLAlchemy | 2.0 | ORM | Async mode |
```
Group by category: Runtime, Web Framework, Database, Cache, Queue, Testing, Linting, CI/CD.

**When to update:** Any dependency add/remove/upgrade.

### 4. `docs/project-structure.md` — Directory Map

**Purpose:** Map each directory to its responsibility. Agents use this to locate
the right file without grepping.

**Structure:**
```markdown
| Directory | Responsibility | Key Files |
|-----------|----------------|-----------|
| src/api/ | HTTP route handlers | routes.py, middleware.py |
| src/services/ | Business logic | auth.py, payments.py |
| src/models/ | ORM models | user.py, order.py |
| tests/ | Test suite | conftest.py, test_api/ |
```

**When to update:** Any directory addition, removal, or repurposing.

### 5. `docs/conventions.md` — Code Style & Patterns

**Purpose:** Document conventions that differ from or extend language defaults.
Only rules an agent can't infer from linter config or codebase scanning.

**Structure:**
- Naming conventions (files, variables, functions, classes, DB tables)
- Import ordering and style (if not covered by tooling)
- Error handling patterns (what gets raised vs returned, what gets logged)
- Logging conventions (levels, structured logging, sensitive data)
- Configuration management (env vars, config files, secrets)
- Testing conventions (file naming, fixture patterns, mock policy, test data)
- Commit conventions (if not in `CONTRIBUTING.md`)
- Security rules ("never commit .env", auth patterns)

**Quality gate:** Every convention must be falsifiable — an agent can look at code
and determine if it's followed.

**When to update:** When conventions change, or when a new pattern emerges.

### 6. `docs/modules/<name>.md` — Module Deep Dive

**Purpose:** One file per logical module. Comprehensive reference for understanding
and modifying that module.

**Structure:**
- **Purpose** (1 sentence)
- **Public API** — exported functions, classes, routes with signatures
  ```markdown
  | Function | Signature | Description |
  |----------|-----------|-------------|
  | login | (email: str, password: str) -> Token | Authenticate user |
  ```
- **Dependencies** — Inbound (who imports this) + Outbound (what this imports)
- **Data Models** owned by this module (if any)
- **Patterns & Gotchas** — non-obvious behaviour, concurrency concerns, edge cases

**Naming:** `docs/modules/<name>.md` where `<name>` matches the source directory
or the logical domain concept (e.g., `docs/modules/auth.md`).

**When to update:** Any change to the module's public API, dependencies, or patterns.

### 7. `docs/api-reference.md` — HTTP API Reference

**Purpose:** Complete catalog of HTTP endpoints. Auto-generated from route definitions.

**Structure:**
- Base URL and versioning scheme
- Authentication requirements (header format, token type)
- Error response format (standard shape)
- Endpoints grouped by resource:
  ```markdown
  | Method | Path | Auth | Request Body | Response | Description |
  |--------|------|------|-------------|----------|-------------|
  | POST | /auth/login | None | {email, password} | {token, user} | Login |
  ```

**When to update:** Any route addition, removal, or signature change.

### 8. `docs/data-models.md` — Data Layer

**Purpose:** Entity-relationship overview and schema reference.

**Structure:**
- ER overview (Mermaid `erDiagram`)
- Per-entity: fields, types, constraints, relationships, indexes
- Migration strategy (Alembic, Prisma, Flyway, etc.)
- Database connection and pool config

**When to update:** Any model/schema change.

### 9. `docs/setup.md` — Getting Started

**Purpose:** One-shot guide to get the project running from zero.

**Structure:**
- Prerequisites (language version, system deps, services)
- Clone + install
- Environment configuration (every env var with description + default)
- Database setup (create, migrate, seed)
- Run (dev server, build, all-in-one)
- Docker setup (if `docker-compose.yml` or `Dockerfile` exists)
- Verify (how to confirm everything works)

**When to update:** Any change to install steps, env vars, or run commands.

### 10. `docs/testing.md` — Testing Guide

**Purpose:** How to run tests, what to test, testing conventions.

**Structure:**
- Test framework and runner
- Commands: full suite, single file, single test, coverage
- Test directory layout and naming
- Fixture/factory patterns (where they live, how to use them)
- Mock policy (what gets mocked vs real)
- CI test workflow (if detectable)

**When to update:** Any change to test config, commands, or conventions.

### 11. `docs/workflows.md` — Task Recipes

**Purpose:** Step-by-step recipes for common development tasks. Agents use these
as playbooks for structured work.

**Structure:**
Each recipe follows this format:
```markdown
### Adding a New API Endpoint
1. Add route to `src/api/routes/<resource>.py`
2. Add service logic to `src/services/<resource>.py`
3. Add tests to `tests/api/test_<resource>.py`
4. Update `docs/api-reference.md`
5. Update `docs/modules/<resource>.md`
```

Common recipes: new endpoint, new model, new module, running a migration,
deploying, debugging.

**When to update:** When a workflow changes or a new one needs documenting.

### 12. Root `README.md` — Project Front Door

**Purpose:** The project's public entry point (repo home page, package page).
It is NOT part of the `docs/` tree, but this skill owns keeping it in sync —
documentation is incomplete if the root README describes a stale stack or
doesn't link to the docs.

**Structure:**
- Project name + one-line description (matches `docs/README.md` summary)
- Quick start: install, run, test commands (from `docs/setup.md`, `docs/testing.md`)
- Link to docs hub: `[Documentation](docs/README.md)`
- Tech stack highlights (from `docs/tech-stack.md`)
- License / status badges (if present)

**Rules:**
- Link into `docs/`, don't duplicate deep content (one home per fact)
- If no root `README.md` exists, create one; if it exists, update stale
  sections rather than rewriting wholesale
- If the project deliberately uses a different entry doc (static site
  `docs/index.html`), update that instead and note it in the audit report

**When to update:** Whenever the docs tree, stack, or run commands change.

---

## Document Generation Order

Files must be generated in this order because later files reference earlier ones:

1. `tech-stack.md` (no dependencies)
2. `project-structure.md` (no dependencies)
3. `architecture.md` (depends on tech-stack, project-structure)
4. `conventions.md` (no dependencies)
5. `modules/*.md` (depends on project-structure, architecture)
6. `api-reference.md` (depends on modules)
7. `data-models.md` (depends on modules)
8. `setup.md` (depends on tech-stack)
9. `testing.md` (depends on tech-stack, conventions)
10. `workflows.md` (depends on modules, conventions)
11. `docs/README.md` (depends on everything — generate LAST)
12. Root `README.md` (depends on docs hub, setup, tech-stack — after the docs tree)
