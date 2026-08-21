# Uniterra Documentation

Uniterra is a desktop app built on the DeepSeek Harness (dsh) agent runtime and community dsh plugins: an Electron shell boots a bundled dsh CLI, provisions built-in plugins + skills into the user's profile, and hosts dsh's Web UI. Its goal is to let users quickly build their own desktop agent app through plugins. Built-in workflows: a four-phase TDD development pipeline (`uniterra-plan` → `uniterra-implement` → `uniterra-simplify` / `uniterra-review`), an invariant-first debugging workflow (`uniterra-pbt-debugging`), and project-documentation management skills. Built-in provider enhancement: freely configure external OpenAI-compatible providers and fetch upstream model metadata (models.dev).

Quick links: [Setup](setup.md) · [Architecture](architecture.md) · [Tech Stack](tech-stack.md) · [Root README](../README.md)

## I want to...

| I want to...                                             | Read...                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Set up / install the app or the dev repo                 | [setup.md](setup.md)                                                 |
| Understand the system design                             | [architecture.md](architecture.md)                                   |
| Know what technologies we use                            | [tech-stack.md](tech-stack.md)                                       |
| Find where code lives                                    | [project-structure.md](project-structure.md)                         |
| Know the code conventions                                | [conventions.md](conventions.md)                                     |
| Understand the Electron shell / boot flow                | [modules/uniterra-desktop.md](modules/uniterra-desktop.md)           |
| Understand the LLM provider (dual protocol + models.dev) | [modules/uniterra-provider.md](modules/uniterra-provider.md)         |
| Understand the installer CLI (`uniterra setup`)          | [modules/uniterra-cli.md](modules/uniterra-cli.md)                   |
| Understand the update check                              | [modules/uniterra-updater.md](modules/uniterra-updater.md)           |
| Understand the built-in skills + workflows               | [modules/uniterra-skills.md](modules/uniterra-skills.md)             |
| Understand the system-prompt working rules               | [modules/uniterra-systemprompt.md](modules/uniterra-systemprompt.md) |
| Understand the built-in plugin set / vendoring policy    | [modules/vendor-plugins.md](modules/vendor-plugins.md)               |
| Run the tests / verification                             | [testing.md](testing.md)                                             |
| Do a common dev task                                     | [workflows.md](workflows.md)                                         |

## Document Index

- [tech-stack.md](tech-stack.md) — languages, frameworks, tools, versions, external services
- [project-structure.md](project-structure.md) — directory map, packages, skills, vendored plugins
- [architecture.md](architecture.md) — C4 diagrams, boot/data flow, decisions, deployment
- [conventions.md](conventions.md) — code style, dependencies, testing, build/distribution rules
- [setup.md](setup.md) — end-user install, developer setup, env vars, verify
- [testing.md](testing.md) — per-package lanes, PBT invariants, container harness
- [workflows.md](workflows.md) — task recipes (feature, debug, skill, plugin, release, docs)
- [modules/uniterra-desktop.md](modules/uniterra-desktop.md) — Electron shell, boot flow, path resolution, update check
- [modules/uniterra-provider.md](modules/uniterra-provider.md) — dual-protocol adapter, config, wire invariants, settings page
- [modules/uniterra-cli.md](modules/uniterra-cli.md) — `uniterra setup` / `uniterra update`, install flow, release
- [modules/uniterra-updater.md](modules/uniterra-updater.md) — update-decision semantics, skip persistence
- [modules/uniterra-skills.md](modules/uniterra-skills.md) — skill registry, provisioning, the 7 bundled skills
- [modules/uniterra-systemprompt.md](modules/uniterra-systemprompt.md) — working-rule injection extension
- [modules/vendor-plugins.md](modules/vendor-plugins.md) — npm/vendored/optional/workspace built-ins, pin ledger, update policy

Not present (do not apply): `api-reference.md` (no HTTP routes), `data-models.md` (no database — config schemas are documented in their module docs).

## How to Update

- New doc file → add a row to both the lookup table and this index.
- Removed doc file → delete both rows.
- Project summary changed → mirror it in the root [README](../README.md).
