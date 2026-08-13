# Tech Stack

| Component           | Version  | Purpose         | Notes                                                                     |
| ------------------- | -------- | --------------- | ------------------------------------------------------------------------- |
| Node.js             | >= 22    | Runtime         | Pinned in `.nvmrc` / `engines`; ESM (`"type": "module"`)                  |
| TypeScript          | ~5.9     | Language        | Strict mode, NodeNext module resolution, project references (`tsc -b`)    |
| pnpm                | 11.17.0  | Package manager | `pnpm-workspace.yaml`; `pnpm-lock.yaml`                                   |
| pi-agent            | ^0.84.1  | Extension host  | `@earendil-works/pi-coding-agent` — the pi CLI this extension runs inside |
| typebox             | ^1.3.7   | Tool schema     | `Type.Object` parameter schemas for `pi.registerTool()`                   |
| ESLint              | ^9.34    | Linter          | `typescript-eslint` strictTypeChecked + extra strict rules                |
| Prettier            | ^3.6     | Formatter       | Single quotes, trailing commas, 100 width, LF                             |
| husky + lint-staged | ^9 / ^16 | Pre-commit      | `prettier --write` + `eslint --fix --max-warnings 0` on staged files      |

## Verified imports

- `@earendil-works/pi-coding-agent` — `src/index.ts:21` (`ExtensionAPI`, `ExtensionContext`), `src/state.ts:21` (`getAgentDir`)
- `typebox` — `src/index.ts:24` (`Type`)
- Node built-ins only elsewhere: `node:fs`, `node:path`, `node:child_process`, `node:os`, `node:url`, `node:module`

## Not present

- No web framework, no database, no test framework (see `testing.md`), no CI config yet, no Docker.

## How to Update

- New dependency → add row + verify the import actually appears in `src/` (config alone is not truth).
- Version bump → update the version column and the lockfile.
