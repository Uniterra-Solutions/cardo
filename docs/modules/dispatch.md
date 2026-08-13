# Module: dispatch (`dispatch.ts`)

**Purpose:** Run one pipeline phase subagent as an isolated child `pi` process and return its final output.

Source: `packages/jovaltus/src/dispatch.ts` (211 LOC). Modeled on pi's official subagent extension example (`examples/extensions/subagent/`), simplified to single-agent (no parallel/chain modes, no usage stats).

## Public API

| Export        | Signature                                            | Description                                     |
| ------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `PhaseResult` | `interface`                                          | `{ exitCode, output, error }`                   |
| `runPhase`    | `(options: RunPhaseOptions) => Promise<PhaseResult>` | Spawn child, wait for completion, return output |

`RunPhaseOptions`: `{ cwd, prompt, task, model: string | null, thinkingLevel: string | null, signal?: AbortSignal, onText?: (text: string) => void }`

## Child Process Invocation

```text
pi --mode json -p --no-session --no-extensions --tools read,bash,edit,write,grep,find,ls
   [--model <provider>/<id>[:<thinking>]]
   --append-system-prompt <tmp>/prompt.md
   <task>
```

| Flag                            | Why                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode json -p --no-session`   | Non-interactive, ephemeral; stdout is JSONL events                                                                                            |
| `--no-extensions`               | Prevents the child from recursively loading this extension (no `agent_settled` re-dispatch inside the child, no shared state-file contention) |
| `--tools` allowlist             | Phase subagents get coding built-ins only                                                                                                     |
| `--model` / `--thinking`        | Inherited from the parent session when available                                                                                              |
| `--append-system-prompt <file>` | Phase prompt travels as a temp file (avoids shell quoting issues); task text is the final positional arg                                      |

## Output Extraction

- Parses the last ≤200 JSONL lines for the final `message_end` assistant message.
- `text`-typed content parts are joined with `\n` (type-guarded; non-string text ignored).
- On child failure, `error` carries the stderr tail (last 4000 chars) for diagnostics.

## Dependencies

- Inbound: `index.ts` (`dispatchPhase` → `runPhase`).
- Outbound: `node:child_process`, `node:fs`, `node:os`, `node:path`.

## Patterns & Gotchas

- **`getPiInvocation` resolution:** reuses `process.execPath` when it is a concrete pi binary, falls back to `pi` on PATH — mirrors the official example.
- **Abort handling:** SIGTERM then SIGKILL after 5s on abort; temp dir removed best-effort in `finally`-style `finish`.
- **No API key check here:** the child inherits the parent's env/auth (`~/.pi/agent/auth.json`); if pi is not logged in, the child fails with exit ≠ 0 and the phase fails deterministically.

## How to Update

- New child flag → add to invocation + the flag table.
- Output parsing changed → update Output Extraction + `extractAssistantTextDelta` (`dispatch.ts:185-204`).
