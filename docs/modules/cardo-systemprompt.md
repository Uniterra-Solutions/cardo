# Module: cardo-systemprompt

**Purpose:** pi-agent extension that appends the app-wide working rules to every agent turn's system prompt via a `before_agent_start` handler.

Source: `packages/cardo-systemprompt/src/index.ts`; tests `test/general.test.mjs`.

## Registration

- `package.json` exposes `"pi": { "extensions": ["./src/index.ts"] }`.
- The entry is a **default-exported factory** `generalExtension(pi: ExtensionAPI)` — pi's loader requires `jiti.import(path, { default: true })` then `typeof factory === 'function'`. This is the single platform exception to the no-default-exports rule.
- Handler: `pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\n\n' + WORKING_RULES }))` — stateless rebuild from `event.systemPrompt`, so rules stay active all session with no cross-turn duplication (locked by test).

## Working Rules

Appended to every turn:

| #   | Rule                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Never use emoji in replies                                                                                                     |
| 2   | Talk less, work more; only ask when something genuinely needs user clarification                                               |
| 3   | Do not over-engineer; never make unrequested refactors or changes                                                              |
| 4   | Match comment density to code complexity — prefer precise names and concise code                                               |
| 5   | Code is liability, not asset: write not one line more than needed                                                              |
| 6   | Research the latest usage and APIs of external libraries before writing code; never write from memory                          |
| 7   | Develop test-driven: understand the logic, write tests for each piece of business logic, minimal change to pass, then refactor |
| 8   | Reply in the user's language by default                                                                                        |

## Test Guarantees

- `before_agent_start` handler is registered.
- Output starts with the base prompt and includes rules 1, 7, 8 verbatim.
- Running the handler twice yields identical output with exactly one occurrence of each rule (no accumulation).

## Dependencies

- Outbound: `@earendil-works/pi-coding-agent` (types + `ExtensionAPI`).
- Inbound: none in-repo (consumed by the pi runtime via the `pi.extensions` manifest).

## Patterns & Gotchas

- Keep the factory default-exported and the filename `src/index.ts` — pi's loader contract.
- Rules live here only; `AGENTS.md` mirrors the falsifiable subset for human agents.

## How to Update

- Rule added/changed → edit `WORKING_RULES`, extend the test, run `pnpm run build` (desktop consumes the built `dist` export).

## Find It Fast

```bash
grep -n 'WORKING_RULES' packages/cardo-systemprompt/src/index.ts
```
