# @cardo/skills — built-in skill registry

Bundles the company-standard agent skills and injects them into the desktop
app. The desktop app provisions them into pi's user-level skills directory at
startup, so they show up in the Skills view and are invocable via `/skill:name`
like any user skill.

## Bundled skills (source of truth: `src/skills/`)

Vendored from the Hermes plugins — re-sync by copying the directories:

| Skill                                                                                     | Origin                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `agentic-debugging`, `manage-agents-md`, `manage-git-repo`, `project-documentation`, `qa` | `jovaltus/src/jovaltus/skills/`                |
| `create-skill`                                                                            | `caelterra/src/caelterra/skills/create-skill/` |

`scripts/copy-skills.mjs` copies `src/skills/*` → `dist/skills/` during the
build; consumers must load this package from its built `dist` output.

## API

- `provisionBuiltinSkills(agentDir, { force? })` — copy each bundled skill into
  `<agentDir>/skills/<name>`, skipping existing directories (unless `force`);
  returns `{ installed, skipped, failed }` and never throws.
- `resolveAgentDir()` — pi's agent config dir: `PI_CODING_AGENT_DIR` (tilde
  expanded) or `~/.pi/agent` (mirrors pi's `getAgentDir()` without importing
  the ESM-only pi package from the CJS Electron main bundle).
- `listBuiltinSkills()` / `builtinSkillNames` / `builtinSkillsDir()` — metadata
  and the bundled content root.

## Verify

`pnpm --filter @cardo/skills test` — builds, then runs provisioning tests
(metadata consistency, idempotency, no-clobber, force, agent-dir resolution).
