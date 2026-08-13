# Module: extension (`index.ts`)

**Purpose:** pi extension entry — registers the 4 pipeline tools and the 2 lifecycle events that drive the Jovaltus pipeline.

Source: `packages/jovaltus/src/index.ts` (439 LOC). Ported from the Hermes plugin's `src/jovaltus/tools.py` + `src/jovaltus/hooks.py`.

## Public API

| Export    | Signature                    | Description                                                                                       |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `default` | `(pi: ExtensionAPI) => void` | Factory called by pi's loader at startup. Single default export in the package (loader contract). |

## Registered Tools

| Tool       | Parameters (typebox)                       | Behavior                                                                                                  |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `plan`     | `{ user_requirements: string }` (required) | Runs prd → research → acceptance → tasks synchronously; writes artifacts to `<cwd>/.plan/<date>/<slug>/`. |
| `execute`  | `{ plan: string }` (required)              | Validates plan exists; runs the execute phase as one child; leaves changes uncommitted.                   |
| `simplify` | `{ plan?: string }` (optional)             | Runs simplify-review child; verdict loop (fix → main agent fixes → re-review).                            |
| `review`   | `{ plan?: string }` (optional)             | Runs adversarial-review child; same verdict loop.                                                         |

### Tool result contract

- Success: `{ content: [{ type: "text", text }], details: { run_dir, ... } }`
- Error: `details: { isError: true }` (tool returns a value — never throws)
- Fix verdict: `details: { verdict: "fix", findings }`; text instructs the main agent to fix.

## Registered Events

| Event                | Equivalent (Hermes) | Behavior                                                                                                                                                                                     |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_agent_start` | `pre_llm_call`      | Injects `[Jovaltus pipeline] tool=... phase=... status=...` into every main-agent turn's system prompt when a pipeline exists.                                                               |
| `agent_settled`      | `post_llm_call`     | After the main agent's fixing turn, re-dispatches the reviewer for a parked `*_waiting` pipeline; `fix` → `pi.sendUserMessage(findings)` wakes the next fix round; `pass` → notify + finish. |

## Dependencies

- Inbound: none (loaded by pi host).
- Outbound: `state.ts` (pipeline machine), `chain.ts` (CHAIN/verdict), `dispatch.ts` (child runner), `prompts.ts` (render), `@earendil-works/pi-coding-agent` (types + ExtensionAPI), `typebox` (schemas), `node:fs`, `node:path`.

## Patterns & Gotchas

- **Run-dir collision handling:** `computeRunDir` appends `-2`, `-3`, … when `<date>/<slug>` already exists (`index.ts:44-53`).
- **Review target resolution:** with a plan, run dir = plan's parent; without one, a fresh `.plan/<date>/<tool>` dir is created (`resolveReviewTarget`, `index.ts:88-95`).
- **Model inheritance:** child gets `--model <provider>/<id>:<thinking>` from the parent ctx when available (`modelPattern`, `index.ts:136-148`).
- **Event no-op rule:** `agent_settled` acts only when pipeline status is `running` AND phase is `*_waiting`; everything else is a no-op so the hook is effectively absent before/after a run.

## How to Update

- New tool → register in the factory + add row to the tools table.
- Changed verdict flow → update the tool result contract + event table.
