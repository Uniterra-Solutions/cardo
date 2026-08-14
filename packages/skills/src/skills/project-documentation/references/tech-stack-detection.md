# Technology Stack Detection Matrix

How to detect the project's technology stack from config files and source code.
Always verify framework claims by reading actual imports — never trust config
files alone.

---

## Detection Priority

Read files in this order. The first match determines the primary language/runtime.

| Priority | Config File | Language | Package Manager | Build System |
|----------|-------------|----------|-----------------|-------------|
| 1 | `pyproject.toml` | Python | uv / pip / poetry | setuptools / hatchling |
| 2 | `package.json` | TypeScript/JS | npm / yarn / pnpm | (in scripts) |
| 3 | `Cargo.toml` | Rust | cargo | cargo |
| 4 | `go.mod` | Go | go modules | go build |
| 5 | `Gemfile` | Ruby | bundler | rake |
| 6 | `composer.json` | PHP | composer | (in scripts) |
| 7 | `pom.xml` | Java | Maven | Maven |
| 8 | `build.gradle` / `build.gradle.kts` | Java/Kotlin | Gradle | Gradle |
| 9 | `mix.exs` | Elixir | mix | mix |
| 10 | `CMakeLists.txt` | C/C++ | (varies) | CMake |

---

## Framework Detection (by Language)

### Python (`pyproject.toml` / `requirements.txt`)

Look for these dependency names (check `[project] dependencies` or `[tool.poetry.dependencies]`):

| Dependency | Framework | Type |
|------------|-----------|------|
| `fastapi` | FastAPI | Web API |
| `django` | Django | Full-stack web |
| `flask` | Flask | Micro web |
| `litestar` | Litestar | Web API |
| `sanic` | Sanic | Async web |
| `tornado` | Tornado | Async web |
| `sqlalchemy` | SQLAlchemy | ORM |
| `sqlmodel` | SQLModel | ORM (FastAPI) |
| `django-ninja` | Django Ninja | Web API (Django) |
| `pydantic` | Pydantic | Data validation |
| `celery` | Celery | Task queue |
| `pytest` | pytest | Testing |
| `ruff` | ruff | Linter/Formatter |

**Verify by reading imports** in the main app file:
```python
from fastapi import FastAPI  # → FastAPI
from flask import Flask      # → Flask
```

### TypeScript/JavaScript (`package.json`)

Look in `dependencies` and `devDependencies`:

| Dependency | Framework | Type |
|------------|-----------|------|
| `next` | Next.js | Full-stack React |
| `react` + `react-dom` | React | Frontend |
| `vue` | Vue.js | Frontend |
| `@angular/core` | Angular | Frontend |
| `svelte` | Svelte | Frontend |
| `express` | Express | Web server |
| `fastify` | Fastify | Web server |
| `@nestjs/core` | NestJS | Web server |
| `hono` | Hono | Web server |
| `prisma` | Prisma | ORM |
| `drizzle-orm` | Drizzle | ORM |
| `typeorm` | TypeORM | ORM |
| `vitest` | Vitest | Testing |
| `jest` | Jest | Testing |
| `eslint` | ESLint | Linter |
| `prettier` | Prettier | Formatter |

**Verify by reading imports** in entry files:
```typescript
import { NextApiRequest } from 'next'     // → Next.js
import express from 'express'              // → Express
```

### Rust (`Cargo.toml`)

Look in `[dependencies]`:

| Dependency | Framework | Type |
|------------|-----------|------|
| `actix-web` | Actix Web | Web server |
| `axum` | Axum | Web server |
| `rocket` | Rocket | Web server |
| `warp` | Warp | Web server |
| `poem` | Poem | Web server |
| `tokio` | Tokio | Async runtime |
| `sqlx` | SQLx | Database |
| `diesel` | Diesel | ORM |
| `serde` | Serde | Serialization |

### Go (`go.mod`)

Look in `require` block:

| Dependency | Framework | Type |
|------------|-----------|------|
| `github.com/gin-gonic/gin` | Gin | Web server |
| `github.com/labstack/echo` | Echo | Web server |
| `github.com/go-chi/chi` | Chi | Web router |
| `github.com/gorilla/mux` | Gorilla Mux | Web router |
| `github.com/gofiber/fiber` | Fiber | Web server |
| `gorm.io/gorm` | GORM | ORM |
| `github.com/jmoiron/sqlx` | sqlx | Database |

---

## Database Detection

Look for connection strings and ORM configs:

| Signal | Database |
|--------|----------|
| `postgresql://` or `DATABASE_URL=postgres://` | PostgreSQL |
| `mysql://` | MySQL |
| `sqlite://` or `*.sqlite` | SQLite |
| `mongodb://` | MongoDB |
| `redis://` | Redis |
| `DATABASE_URL=...` in `.env.example` | Check the scheme |
| Alembic directory (`migrations/`, `alembic/`) | SQL database with migrations |
| Prisma schema (`prisma/schema.prisma`) | (check `datasource` block) |
| `docker-compose.yml` services named `db`, `postgres`, `mysql` | Check image name |

---

## Infrastructure Detection

| Signal | Service |
|--------|---------|
| `docker-compose.yml` with `redis` | Redis cache/queue |
| `docker-compose.yml` with `rabbitmq` | RabbitMQ queue |
| `celery` in Python deps | Celery task queue (check broker) |
| `bull` / `bullmq` in JS deps | Bull task queue (Redis-backed) |
| `docker-compose.yml` with `elasticsearch` | Elasticsearch |
| `KAFKA_BROKERS` env var or `kafka-python` dep | Kafka |
| `AWS_ACCESS_KEY_ID` in `.env.example` | AWS services |
| `Dockerfile` with `FROM nginx` | Nginx reverse proxy |
| `nginx.conf` or `nginx/` directory | Nginx config |

---

## Package Manager Detection

| File | Package Manager |
|------|----------------|
| `uv.lock` | uv |
| `poetry.lock` | Poetry |
| `Pipfile.lock` | Pipenv |
| `requirements.txt` (no lockfile) | pip |
| `package-lock.json` | npm |
| `yarn.lock` | Yarn |
| `pnpm-lock.yaml` | pnpm |
| `bun.lockb` / `bun.lock` | Bun |
| `Cargo.lock` | Cargo |
| `go.sum` | Go modules |
| `Gemfile.lock` | Bundler |

---

## Python `pyproject.toml` Dependency Extraction

The standard way dependencies are declared:

### PEP 621 (modern):
```toml
[project]
dependencies = ["fastapi>=0.115", "sqlalchemy>=2.0"]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.8"]
```

### Poetry:
```toml
[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.115"

[tool.poetry.group.dev.dependencies]
pytest = "^8"
```

### uv (groups):
```toml
[dependency-groups]
dev = ["pytest>=8", "ruff>=0.8"]
```

---

## Edge Cases

1. **Monorepo** — multiple `package.json` / `pyproject.toml` files in subdirectories.
   Detect: check if root config references workspaces (`pnpm-workspace.yaml`, `workspaces` in `package.json`).
   For monorepos, document each package's `docs/` under its own directory.

2. **Polyglot project** — both `pyproject.toml` AND `package.json` at root.
   Detect: check both. Determine primary language from entry points.
   Generate separate tech-stack sections per language.

3. **No config file** — some projects use plain scripts with no manifest.
   Detect: look for shebangs (`#!/usr/bin/env python`), file extensions.
   Flag as `[INFERRED]` and document what's observable.

4. **Multiple frameworks** — e.g., FastAPI + Celery in one project.
   Document all detected frameworks. Order by prominence (route count, import frequency).
