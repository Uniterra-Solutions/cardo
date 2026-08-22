# Task List — per-task contract for the workflow script

The workflow script receives the task list through `args`. **Each task carries a
pre-rendered markdown `prompt`** — a single flat string the subagent reads verbatim,
already built at decomposition time from the task's goal/context/requirements/
conventions/constraints. This keeps `args` flat, so the orchestrator never has to
serialize a deep nested JSON (which is what corrupts the tool call).

## Shape

```json
{
  "goal": "one-line feature goal (shared by every task)",
  "tasks": [
    {
      "id": "T1",
      "name": "…",
      "prompt": "# Task: …\n\n… (rendered markdown, see below) …"
    }
  ]
}
```

- For the **batched** shape use `"batches": [ [ { id, name, prompt } ], … ]` (an array
  of task arrays) instead of `"tasks"`.
- `goal` is hoisted to the top level as a heading-only anchor; the real content lives in
  each `prompt`. If `goal` is not needed inside the prompts, it may be omitted.

## Field notes

- `id` — stable identifier, used as the agent `label` for observability.
- `name` — one-line task name.
- `prompt` — the **entire subagent instruction block as one markdown string**. It must
  include, at minimum, the sections rendered below (goal, requirements with their
  `test`, conventions, context files, constraints). The script appends the shared
  `FIXED_RULES` (see `assets/workflow-script-example.md`) after it at run time.
- **Do not** put `goal` / `context` / `requirements` / `conventions` / `constraints` as
  separate nested fields in `args` — they are flattened into `prompt`. Keeping them as a
  nested object is what forces a deep JSON and corrupts the call.

## Rendering the `prompt`

At decomposition time, render each task into markdown, e.g.:

```markdown
# Task: <name>

## Goal

<goal>

## Context

- <path> — <description> (read: <symbol / §section>)
- …

## Requirements

- <REQ-id>: <text> — [test: <package/x/test.ts → 'case'>]
- …

## Conventions

- <module-local test command or convention>
- …

## Constraints

- owned_files: <path>, <path>
- forbidden_files: <path>, <path>
```

## Example

```json
{
  "goal": "Add user authentication with refresh-token rotation",
  "tasks": [
    {
      "id": "auth-issue",
      "name": "Token issuance endpoint",
      "prompt": "# Task: Token issuance endpoint\n\n## Goal\nAdd user authentication with refresh-token rotation\n\n## Context\n- packages/auth/src/issue.ts — empty module to implement (read: (new file))\n- packages/auth/src/token.ts — TokenPayload type + sign/verify helpers (read: function signToken)\n\n## Requirements\n- REQ-1: POST /auth/token returns an access and a refresh token — [test: packages/auth/test/issue.test.ts → 'returns both tokens']\n- REQ-2: Access token expires after 15 minutes — [test: packages/auth/test/issue.test.ts → 'access token TTL is 15m']\n\n## Conventions\n- run: pnpm --filter @cardo/auth test\n- token claims live in TokenPayload (packages/auth/src/token.ts)\n\n## Constraints\n- owned_files: packages/auth/src/issue.ts\n- forbidden_files: packages/auth/src/refresh.ts"
    },
    {
      "id": "auth-refresh",
      "name": "Refresh-token rotation",
      "prompt": "# Task: Refresh-token rotation\n\n## Goal\nAdd user authentication with refresh-token rotation\n\n## Context\n- packages/auth/src/refresh.ts — empty module to implement (read: (new file))\n\n## Requirements\n- REQ-3: A refresh token can be rotated exactly once — [test: packages/auth/test/refresh.test.ts → 'rotates once then rejects']\n\n## Conventions\n- run: pnpm --filter @cardo/auth test\n\n## Constraints\n- owned_files: packages/auth/src/refresh.ts\n- forbidden_files: packages/auth/src/issue.ts"
    }
  ]
}
```

Paths are repo-relative — the subagent's cwd is the repo root.
