# agentskills.io Specification Summary

This reference summarises the [Agent Skills specification](https://agentskills.io/specification)
for the common fields used in skill creation.

## Required Directory Structure

```
skill-name/
├── SKILL.md          # Required — YAML frontmatter + Markdown body
├── scripts/          # Optional — executable code
├── references/       # Optional — supplementary docs loaded on demand
└── assets/           # Optional — templates and static output files
```

## SKILL.md Frontmatter Fields

| Field         | Required | Max length | Rules |
|---------------|----------|------------|-------|
| `name`        | Yes      | 64 chars   | Lowercase, hyphens, digits only. No consecutive hyphens. Must match directory name. |
| `description` | Yes      | 1024 chars | Only field the agent sees before loading. Must include trigger phrases and negative triggers. Third-person imperative. |

Do NOT add other YAML frontmatter fields unless the host platform specifically
requires them (e.g. OpenAI's `metadata.short-description`).

## Body Structure

The body is loaded only after the skill is triggered. Best practices:

| Section         | Purpose |
|-----------------|---------|
| `## Goal`       | Core transformation the skill performs. One paragraph. |
| `## Workflow`   | Phased procedure. Behavioural guidance only. |
| `## Gotchas`    | Environment-specific facts that break model defaults. |
| `## References` | Index of reference files with clear when-to-read instructions. |
| `## Scripts`    | Index of bundled scripts with usage notes. |

## Key Rules

1. **No documentation files** in the skill directory — no README, CHANGELOG,
   LICENSE, or INSTALLATION_GUIDE.
2. **One level deep** — references/scripts/assets are flat. No nested
   subdirectories.
3. **Relative paths only** — use forward slashes for cross-references.
4. **Name must match directory** — agents load by directory name.
