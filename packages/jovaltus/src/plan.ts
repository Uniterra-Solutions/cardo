/**
 * Plan-mode execution plan model (jovaltus) — schema + total parser.
 *
 * The execution plan is a **batch-major DAG**: batches run serially, agents
 * within a batch run in parallel. The `execution_mode` constrains the batch
 * shape so the whole graph is derivable from the JSON alone:
 *
 *   serial   — N batches × 1 agent (a linear chain).
 *   batched  — M batches × ≥1 agent (serial between batches, parallel within).
 *   parallel — exactly 1 batch × all agents (fully parallel).
 *
 * This module is deliberately pure: it validates untrusted input (the plan
 * agent's JSON) and normalizes it to a canonical `ExecutionPlan`. All
 * downstream consumers (steps derivation, mermaid generation, progress
 * tracking) treat this shape as ground truth — they never parse mermaid or
 * re-derive the graph from free text.
 */

export type ExecutionMode = 'serial' | 'batched' | 'parallel';

export interface PlanAgent {
  readonly id: string;
  readonly task_prompt: string;
}

export interface ExecutionPlan {
  readonly execution_mode: ExecutionMode;
  /** Batch-major order; each batch is a set of agents that run in parallel. */
  readonly batches: readonly (readonly PlanAgent[])[];
}

/** Node ids must stay mermaid-safe: [A-Za-z0-9_-]+, no quotes/spaces. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Total parse: never throws on arbitrary input. Returns `null` for anything
 * that is not a canonical execution plan (wrong mode, empty batches, empty
 * task_prompt, duplicate or unsafe ids, mode/shape mismatch).
 */
export function parseExecutionPlan(input: unknown): ExecutionPlan | null {
  if (!isPlainObject(input)) {
    return null;
  }
  const mode = input.execution_mode;
  if (mode !== 'serial' && mode !== 'batched' && mode !== 'parallel') {
    return null;
  }
  if (!Array.isArray(input.batches) || input.batches.length === 0) {
    return null;
  }
  const batches: PlanAgent[][] = [];
  const seen = new Set<string>();
  for (const rawBatch of input.batches) {
    if (!Array.isArray(rawBatch) || rawBatch.length === 0) {
      return null;
    }
    const batch: PlanAgent[] = [];
    for (const rawAgent of rawBatch) {
      if (!isPlainObject(rawAgent)) {
        return null;
      }
      const { id, task_prompt } = rawAgent;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        return null;
      }
      if (typeof task_prompt !== 'string' || task_prompt.trim().length === 0) {
        return null;
      }
      if (seen.has(id)) {
        return null;
      }
      seen.add(id);
      batch.push({ id, task_prompt });
    }
    batches.push(batch);
  }
  if (mode === 'serial' && batches.some((batch) => batch.length !== 1)) {
    return null;
  }
  if (mode === 'parallel' && batches.length !== 1) {
    return null;
  }
  return { execution_mode: mode, batches };
}

/** Number of agents across all batches. */
export function agentCount(plan: ExecutionPlan): number {
  let count = 0;
  for (const batch of plan.batches) {
    count += batch.length;
  }
  return count;
}
