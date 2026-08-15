# Module: chain (`chain.ts`)

**Purpose:** Phase-transition tables and verdict.json readers shared by the tool handlers and the `agent_settled` event.

Source: `packages/jovaltus/src/chain.ts` (85 LOC). Ported from the Hermes plugin's CHAIN table (`src/jovaltus/tools.py`) and verdict readers (`src/jovaltus/hooks.py`).

## Public API

| Export           | Signature                                | Description                                                                                             |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `CHAIN`          | `Record<string, Record<string, string>>` | Phase → next phase per tool (see below)                                                                 |
| `WAITING_PHASES` | `readonly string[]`                      | `plan_waiting`, `simplify_waiting`, `review_waiting`                                                    |
| `waitingPhase`   | `(tool) => string`                       | `plan`→`plan_waiting`, `simplify`→`simplify_waiting`, `review`→`review_waiting`; throws for other tools |
| `readVerdict`    | `(p: PipelineState) => string \| null`   | `verdict.json` → `"pass"` \| `"fix"`; null when missing/invalid                                         |
| `readFindings`   | `(p: PipelineState) => string`           | `verdict.json` → `findings` text; `""` when unavailable                                                 |

## CHAIN Table

```text
plan:      prd → design → plan_waiting (agent_settled validates execution-plan.json → done)
execute:   execute → done
simplify:  simplify ⇄ simplify_waiting (verdict-driven loop) → done on "pass"
review:    review ⇄ review_waiting (verdict-driven loop) → done on "pass"
```

The waiting phases dispatch NO subagent. `plan_waiting` hands off to the **main agent** (write failing PBTs + `execution-plan.json`; `agent_settled` validates the artifact); `simplify_waiting`/`review_waiting` wait for the main agent's fixing turn, after which `agent_settled` re-dispatches the reviewer.

## Verdict Contract (`<run_dir>/verdict.json`)

```json
{ "verdict": "fix", "findings": "T1: bug ...\nT2: leak ..." }
```

- `verdict` MUST be exactly `"pass"` or `"fix"` — anything else reads as null (callers fail the pipeline deterministically).
- `findings` MUST be a single string (may be empty on pass).

## Dependencies

- Inbound: `index.ts` (handlers + `agent_settled`).
- Outbound: `node:fs`, `node:path`, `type PipelineState` from `state.ts`.

## Patterns & Gotchas

- **Loop invariant:** the `*_waiting` edges never fire a child directly; they exist so `agent_settled` knows the pipeline is parked (plan_waiting → validate `execution-plan.json`; reviewer waiting phases → re-dispatch the reviewer).
- **Missing/invalid verdict is a hard failure:** the pipeline finishes `failed` with `verdict.json missing or invalid` rather than looping. Same for a missing/invalid `execution-plan.json` at plan_waiting settlement.

## How to Update

- New tool chain → add entry to `CHAIN` + this table.
- Verdict shape changed → update the contract + `readVerdict`/`readFindings`.
