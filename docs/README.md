# Cardo Documentation

Cardo is a pnpm monorepo whose first package, `packages/jovaltus`, ports the Jovaltus subagent-driven pipeline (plan/execute/simplify/review) to a pi-agent extension. Built on the pi-agent core; plugins live as separate workspace packages. The desktop shell is pi-gui (vendored under `vendor/pi-gui`), consuming cardo extensions as built-ins via `packages/runtime`.

Quick links: [Setup](setup.md) · [Architecture](architecture.md) · [Tech Stack](tech-stack.md) · [Root README](../README.md)

## I want to...

| I want to...                             | Read...                                      |
| ---------------------------------------- | -------------------------------------------- |
| Set up the project from zero             | [setup.md](setup.md)                         |
| Understand the system design             | [architecture.md](architecture.md)           |
| Know what technologies we use            | [tech-stack.md](tech-stack.md)               |
| Find where code lives                    | [project-structure.md](project-structure.md) |
| Know the code conventions                | [conventions.md](conventions.md)             |
| Understand the extension entry / 4 tools | [modules/extension.md](modules/extension.md) |
| Understand the pipeline state machine    | [modules/state.md](modules/state.md)         |
| Understand phase chains + verdicts       | [modules/chain.md](modules/chain.md)         |
| Understand child process dispatch        | [modules/dispatch.md](modules/dispatch.md)   |
| Understand prompt loading/rendering      | [modules/prompts.md](modules/prompts.md)     |
| Run the tests / verification             | [testing.md](testing.md)                     |
| Do a common dev task                     | [workflows.md](workflows.md)                 |

## Document Index

- [tech-stack.md](tech-stack.md) — languages, frameworks, tools, versions
- [project-structure.md](project-structure.md) — directory map + module map
- [architecture.md](architecture.md) — C4 diagrams, data flow, decisions
- [conventions.md](conventions.md) — code style, testing, commit, security rules
- [modules/extension.md](modules/extension.md) — entry factory, 4 tools, 2 events
- [modules/state.md](modules/state.md) — PipelineState + JSON persistence
- [modules/chain.md](modules/chain.md) — CHAIN tables, verdict readers
- [modules/dispatch.md](modules/dispatch.md) — child pi process runner
- [modules/prompts.md](modules/prompts.md) — prompt files, token substitution
- [setup.md](setup.md) — prerequisites, install, run, verify
- [testing.md](testing.md) — PBT lanes (jovaltus / desktop / driver) + static gates + hermetic verification
- [workflows.md](workflows.md) — task recipes

Not present (do not apply): `api-reference.md` (no HTTP routes), `data-models.md` (no database — `PipelineState` is documented in [modules/state.md](modules/state.md)).

## How to Update

- New doc file → add rows to both the lookup table and this index.
- Removed doc file → delete both rows.
