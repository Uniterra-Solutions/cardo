/**
 * Plan-mode execution progress (jovaltus) — per-agent status machine.
 *
 * Drives both dispatch gating and the frontend's execute panel: which agents
 * may start now (batch gating), and what each agent's light shows (green =
 * done, spinner = running, gray = pending).
 *
 * State is immutable — every transition returns a new `PlanProgress`, so the
 * caller always sees a consistent snapshot. Transitions are strict:
 * `startRunning` accepts only ids returned by `agentsToRun`; `markDone`
 * accepts only ids that are currently `running`. Both throw on violations.
 */

import type { ExecutionPlan } from './plan.js';

export type AgentStatus = 'pending' | 'running' | 'done';

export interface PlanProgress {
  /** Batch-major agent id sets (mirrors the plan's batch structure). */
  readonly batches: readonly (readonly string[])[];
  readonly statuses: ReadonlyMap<string, AgentStatus>;
}

/** All agents start `pending`. */
export function createProgress(plan: ExecutionPlan): PlanProgress {
  const batches = plan.batches.map((batch) => batch.map((agent) => agent.id));
  const statuses = new Map<string, AgentStatus>();
  for (const batch of batches) {
    for (const id of batch) {
      statuses.set(id, 'pending');
    }
  }
  return { batches, statuses };
}

/**
 * Ids that may start now: the pending agents of the earliest batch that is
 * not fully done. Empty when the plan is complete — or when the current
 * batch's agents are already in flight (wait for them to finish first).
 */
export function agentsToRun(progress: PlanProgress): string[] {
  for (const batch of progress.batches) {
    const fullyDone = batch.every((id) => progress.statuses.get(id) === 'done');
    if (!fullyDone) {
      return batch.filter((id) => progress.statuses.get(id) === 'pending');
    }
  }
  return [];
}

/** Marks ids `running`. Precondition: ids ⊆ agentsToRun, no duplicates. */
export function startRunning(progress: PlanProgress, ids: readonly string[]): PlanProgress {
  if (ids.length === 0) {
    throw new RangeError('startRunning: empty id set');
  }
  if (new Set(ids).size !== ids.length) {
    throw new RangeError('startRunning: duplicate ids');
  }
  const allowed = new Set(agentsToRun(progress));
  for (const id of ids) {
    if (!allowed.has(id)) {
      throw new RangeError(`startRunning: ${id} is not allowed to run now`);
    }
  }
  const statuses = new Map(progress.statuses);
  for (const id of ids) {
    statuses.set(id, 'running');
  }
  return { batches: progress.batches, statuses };
}

/** Marks one agent `done`. Precondition: the agent is currently `running`. */
export function markDone(progress: PlanProgress, id: string): PlanProgress {
  if (progress.statuses.get(id) !== 'running') {
    throw new RangeError(`markDone: ${id} is not running`);
  }
  const statuses = new Map(progress.statuses);
  statuses.set(id, 'done');
  return { batches: progress.batches, statuses };
}

/** True when every agent of the plan is `done`. */
export function isComplete(progress: PlanProgress): boolean {
  for (const batch of progress.batches) {
    for (const id of batch) {
      if (progress.statuses.get(id) !== 'done') {
        return false;
      }
    }
  }
  return true;
}
