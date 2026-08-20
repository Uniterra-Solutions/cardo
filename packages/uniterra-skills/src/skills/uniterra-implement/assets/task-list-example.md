# Task List — per-task contract for the workflow script

The workflow script receives the task list through `args`. Shape:

```json
{
  "goal": "one-line feature goal (shared by every task)",
  "tasks": [
    {
      "id": "T1",
      "name": "…",
      "requirements": [
        { "id": "REQ-1", "text": "…", "test": "packages/x/test/a.test.ts → 'should …'" }
      ],
      "conventions": ["module-specific convention or command"],
      "context": {
        "files": [
          { "path": "packages/x/src/a.ts", "description": "…", "read": "function foo / §3.2" }
        ]
      },
      "constraints": {
        "owned_files": ["packages/x/src/a.ts"],
        "forbidden_files": ["packages/x/src/b.ts"]
      }
    }
  ]
}
```

## Field notes

- `goal` — hoisted to the top level because every subagent sees the same feature goal;
  the render function copies it into every prompt.
- `tasks[].id` — stable identifier, used as the agent `label` for observability.
- `tasks[].requirements[].test` — the executable acceptance: which failing test encodes
  this requirement. Point at the test file + case name, not prose.
- `tasks[].conventions` — task-specific, written at decomposition time from `AGENTS.md`
  and the modules this task touches (module-local test commands, naming, invariants).
- `tasks[].context.files[].read` — prefer a symbol / heading (function name, §section);
  line numbers drift, use them only as a secondary hint.
- `tasks[].constraints.owned_files` / `forbidden_files` — the exact file sets. Parallel
  agents may be working at the same time; overlapping `owned_files` between same-batch
  tasks is a decomposition bug.

## Example

```json
{
  "goal": "Add user authentication with refresh-token rotation",
  "tasks": [
    {
      "id": "auth-issue",
      "name": "Token issuance endpoint",
      "requirements": [
        {
          "id": "REQ-1",
          "text": "POST /auth/token returns an access and a refresh token",
          "test": "packages/auth/test/issue.test.ts → 'returns both tokens'"
        },
        {
          "id": "REQ-2",
          "text": "Access token expires after 15 minutes",
          "test": "packages/auth/test/issue.test.ts → 'access token TTL is 15m'"
        }
      ],
      "conventions": [
        "run: pnpm --filter @cardo/auth test",
        "token claims live in TokenPayload (packages/auth/src/token.ts)"
      ],
      "context": {
        "files": [
          {
            "path": "packages/auth/src/issue.ts",
            "description": "empty module to implement",
            "read": "(new file)"
          },
          {
            "path": "packages/auth/src/token.ts",
            "description": "TokenPayload type + sign/verify helpers",
            "read": "function signToken"
          }
        ]
      },
      "constraints": {
        "owned_files": ["packages/auth/src/issue.ts"],
        "forbidden_files": ["packages/auth/src/refresh.ts"]
      }
    },
    {
      "id": "auth-refresh",
      "name": "Refresh-token rotation",
      "requirements": [
        {
          "id": "REQ-3",
          "text": "A refresh token can be rotated exactly once",
          "test": "packages/auth/test/refresh.test.ts → 'rotates once then rejects'"
        }
      ],
      "conventions": ["run: pnpm --filter @cardo/auth test"],
      "context": {
        "files": [
          {
            "path": "packages/auth/src/refresh.ts",
            "description": "empty module to implement",
            "read": "(new file)"
          }
        ]
      },
      "constraints": {
        "owned_files": ["packages/auth/src/refresh.ts"],
        "forbidden_files": ["packages/auth/src/issue.ts"]
      }
    }
  ]
}
```

Paths are repo-relative — the subagent's cwd is the repo root.
