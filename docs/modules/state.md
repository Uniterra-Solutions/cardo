# Module: state (`state.ts`)

**Purpose:** Deterministic pipeline state machine with a SQLite session store at `~/.pi/agent/jovaltus.sqlite`.

Source: `packages/jovaltus/src/state.ts` (582 LOC). Ported from the Hermes plugin's `src/jovaltus/state.py`; persistence moved from a single JSON key (fabricium) to a SQLite session table in pi's `getAgentDir()`.

## Public API

| Export            | Signature                                                       | Description                                                                                     |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PHASES`          | `readonly string[]`                                             | `prd, research, acceptance, tasks, execute, simplify, simplify_waiting, review, review_waiting` |
| `STATUSES`        | `readonly string[]`                                             | `idle, running, done, failed, interrupted`                                                      |
| `PipelineState`   | `interface`                                                     | See data model below                                                                            |
| `getPipeline`     | `() => PipelineState \| null`                                   | Sweep orphans, then the newest session (any status); drops corrupt rows; null when none         |
| `startPipeline`   | `(tool, runDir, userRequirements?, planPath?) => PipelineState` | Insert a new running session; any other running session is superseded → `interrupted`           |
| `setPhase`        | `(p, phase) => void`                                            | Record a phase transition; rejects finished pipelines                                           |
| `setVerdict`      | `(p, verdict) => void`                                          | Record `pass`/`fix`; rejects invalid                                                            |
| `finishPipeline`  | `(p, ok, error?) => void`                                       | Terminal `done`/`failed`; idempotent; no-op on `interrupted`                                    |
| `markInterrupted` | `(p) => void`                                                   | Terminal `interrupted` (stopped without an error); idempotent                                   |
| `listSessions`    | `() => PipelineState[]`                                         | Every session, newest first (insertion order)                                                   |
| `getSession`      | `(idOrRunDir) => PipelineState \| null`                         | Find by session id, or by run_dir (newest match)                                                |
| `resumeSession`   | `(idOrRunDir) => PipelineState`                                 | Re-activate an `interrupted`/`failed` session; throws on missing/running/done                   |
| `statusText`      | `(p) => string`                                                 | One-line `[Jovaltus pipeline] ...` for injection                                                |

## Data Model — PipelineState

| Field               | Type             | Description                                   |
| ------------------- | ---------------- | --------------------------------------------- |
| `id`                | `string`         | unique session id (`randomUUID`)              |
| `run_dir`           | `string`         | abs path `<repo>/.plan/<YYYYmmdd>/<name>/`    |
| `tool`              | `string`         | `plan` \| `execute` \| `simplify` \| `review` |
| `phase`             | `string`         | one of PHASES (or `done`)                     |
| `status`            | `string`         | one of STATUSES                               |
| `user_requirements` | `string`         | plan input text                               |
| `plan_path`         | `string \| null` | required for execute; optional otherwise      |
| `loop_iteration`    | `number`         | simplify/review loop counter (no cap)         |
| `verdict`           | `string \| null` | `pass` \| `fix` \| null                       |
| `updated_at`        | `string`         | ISO timestamp                                 |
| `error`             | `string \| null` | failure message (always null for interrupted) |
| `pid`               | `number`         | OS pid of the owning process (orphan sweep)   |
| `created_at`        | `string`         | ISO timestamp                                 |
| `ended_at`          | `string \| null` | set when the run leaves `running`             |

## Persistence & statuses

SQLite table `sessions` in `<agentDir>/jovaltus.sqlite` (WAL mode). Every run is a row — the store is the session history, so a run survives restarts and can be listed/resumed.

- **`running`** — the active pipeline (at most one; `startPipeline`/`resumeSession` supersede any other running row → `interrupted`).
- **`done` / `failed`** — finished with / without success (`error` records the failure message).
- **`interrupted`** — stopped WITHOUT an error: aborted tool call, `session_shutdown`, superseded by a newer run, or **orphaned** (a `running` row whose `pid` ≠ current process is swept to `interrupted` on the next access — crash/kill recovery). `error` stays `null`.

`getPipeline()` mirrors the pre-history "the one pipeline" semantics: it returns the newest session row regardless of status (so `before_agent_start` keeps injecting the last run's status). Corrupt rows (unknown phase or tool) are dropped so the chain can never deadlock nor silently auto-complete.

## Dependencies

- Inbound: `index.ts` (all handlers + the `session_shutdown` hook).
- Outbound: `@earendil-works/pi-coding-agent` (`getAgentDir`), `node:sqlite` (`DatabaseSync`), `node:crypto`, `node:fs`, `node:path`.

## Patterns & Gotchas

- **Best-effort persistence:** DB failures never crash the pipeline — mutations degrade to in-memory-only; reads degrade to `null`/`[]` (`persistLive`, `state.ts`).
- **Corrupt-store self-healing:** an unreadable `.sqlite` file is deleted and recreated on next open; `getPipeline()` returns `null` and a fresh pipeline starts cleanly.
- **Orphan sweep:** `sweepOrphans` marks `running` rows from a dead pid as `interrupted` before every read/write — a crashed pipeline can never masquerade as active. `resumeSession` sweeps first, so a crash's leftover `running` row is directly resumable (not "already running").
- **Legacy migration:** on first open of an empty store, a pre-SQLite `jovaltus.json` `pipeline` key becomes a session row — `running` migrates as `interrupted` (its owner is gone).
- **Ordering:** reads order by SQLite `rowid DESC` (insertion order), not `created_at` — timestamps can tie within a millisecond.
- **In-memory staleness:** after a session is superseded/resumed, only the store is authoritative; callers must re-read via `getPipeline`/`getSession`.
- **Invalid-row invisibility:** a row whose phase/tool is out-of-domain is dropped by `getPipeline` and invisible to `getSession`/`listSessions`/`resumeSession` (corrupt rows never block the chain).

## Property-based coverage

The store's business logic is locked as invariants in `test/pbt/state-machine.test.mts`:

- **Model-based property:** arbitrary operation sequences (start / advance / verdict / finish / interrupt / resume / orphan-crash) must, after every step, agree with a lock-step reference model and preserve the global invariants: at most one `running` session owned by the current pid, `ended_at` iff not running, `interrupted` never records an error, newest-first listing, `getPipeline` == newest row.
- **Deterministic regressions:** an orphaned `running` row is directly resumable (the resume path sweeps before lookup); corrupted rows are invisible to list/get/resume.
- Bug rule: a property failing on a real bug → fix source + add a deterministic regression test with the minimal counterexample.

## How to Update

- New phase/status → update `PHASES`/`STATUSES` + the chain tables in `chain.ts`.
- New field → add to interface + `SessionRow` + `rowToPipeline` + `insertRow`/`persistLive` + this table + the model-based property in `state-machine.test.mts`.
