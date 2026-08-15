/**
 * Plan-mode execution steps (jovaltus) — derive the ordered step sequence.
 *
 * The execution plan is batch-major: batches run serially, agents within a
 * batch run in parallel. `deriveExecutionSteps` maps that to the dispatcher's
 * working shape — an ordered list of steps, each step being the set of agent
 * ids that may run concurrently:
 *
 *   serial   → N steps of 1 agent (a linear chain)
 *   batched  → M steps = the M batches
 *   parallel → 1 step with all agents (a single batch)
 */

import type { ExecutionPlan } from './plan.js';

/**
 * Returns the ordered steps: `steps[k]` is the set of agent ids that run
 * concurrently at step k. Steps run serially; a step starts only after every
 * agent of the previous step is done.
 */
export function deriveExecutionSteps(plan: ExecutionPlan): string[][] {
  return plan.batches.map((batch) => batch.map((agent) => agent.id));
}
