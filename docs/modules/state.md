# Module: state (`state.ts`)

**Purpose:** Deterministic pipeline state machine with JSON persistence to `~/.pi/agent/jovaltus.json`.

Source: `packages/jovaltus/src/state.ts` (255 LOC). Ported from the Hermes plugin's `src/jovaltus/state.py`; persistence moved from fabricium to pi's `getAgentDir()`.

## Public API

| Export           | Signature                                                       | Description                                                                                     |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PHASES`         | `readonly string[]`                                             | `prd, research, acceptance, tasks, execute, simplify, simplify_waiting, review, review_waiting` |
| `STATUSES`       | `readonly string[]`                                             | `idle, running, done, failed`                                                                   |
| `PipelineState`  | `interface`                                                     | See data model below                                                                            |
| `getPipeline`    | `() => PipelineState \| null`                                   | Read from disk; auto-clears corrupt state; null when idle                                       |
| `startPipeline`  | `(tool, runDir, userRequirements?, planPath?) => PipelineState` | Start (or overwrite) a run in the tool's first phase                                            |
| `setPhase`       | `(p, phase) => void`                                            | Record a phase transition; rejects finished pipelines                                           |
| `setVerdict`     | `(p, verdict) => void`                                          | Record `pass`/`fix`; rejects invalid                                                            |
| `finishPipeline` | `(p, ok, error?) => void`                                       | Terminal `done`/`failed`; idempotent                                                            |
| `statusText`     | `(p) => string`                                                 | One-line `[Jovaltus pipeline] ...` for injection                                                |
| `resetPipeline`  | `() => void`                                                    | Remove the `pipeline` key, keep other keys                                                      |

## Data Model — PipelineState

| Field               | Type             | Description                                   |
| ------------------- | ---------------- | --------------------------------------------- |
| `run_dir`           | `string`         | abs path `<repo>/.plan/<YYYYmmdd>/<name>/`    |
| `tool`              | `string`         | `plan` \| `execute` \| `simplify` \| `review` |
| `phase`             | `string`         | one of PHASES (or `done`)                     |
| `status`            | `string`         | one of STATUSES                               |
| `user_requirements` | `string`         | plan input text                               |
| `plan_path`         | `string \| null` | required for execute; optional otherwise      |
| `loop_iteration`    | `number`         | simplify/review loop counter (no cap)         |
| `verdict`           | `string \| null` | `pass` \| `fix` \| null                       |
| `updated_at`        | `string`         | ISO timestamp                                 |
| `error`             | `string \| null` | failure message                               |

Persistence: whole state dict under the `"pipeline"` key of `~/.pi/agent/jovaltus.json`. Unknown/corrupt phase auto-clears (`getPipeline`, `state.ts:143-160`). Terminal states are absorbing: `setPhase`/`setVerdict` raise on `done`/`failed`.

## Dependencies

- Inbound: `index.ts` (all handlers).
- Outbound: `@earendil-works/pi-coding-agent` (`getAgentDir`), `node:fs`, `node:path`.

## Patterns & Gotchas

- **Best-effort persistence:** a read-only agent dir does not crash the pipeline — state lives in the in-memory object for the run (`persist`, `state.ts:96-106`).
- **Corrupt-state self-healing:** invalid phase → `resetPipeline()` → return null; a stale pipeline can never deadlock the chain.
- **String coercion:** `stringField`/`optionalString` JSON-stringify non-string values rather than `String(unknown)` (avoids `[object Object]`).

## How to Update

- New phase/status → update `PHASES`/`STATUSES` + the chain tables in `chain.ts`.
- New field → add to interface + `fromDict` + this table.
