/**
 * fast-check generators for canonical `ExecutionPlan` values, shared by the
 * plan-mode PBT suites. Three families mirror the schema's mode constraints:
 * serial (N singleton batches), batched (random non-empty partition), parallel
 * (one batch with all agents). Every generator guarantees globally unique,
 * mermaid-safe ids and non-empty task prompts — i.e. inputs `parseExecutionPlan`
 * must accept (the round-trip property pins that).
 */
import * as fc from 'fast-check';
import type { ExecutionPlan, PlanAgent } from '../../dist/plan.js';

const ID = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,19}$/);

/** Benign prompts: structural properties assert against these. */
export const planAgentArb: fc.Arbitrary<PlanAgent> = fc.record({
  id: ID,
  task_prompt: fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
});

/**
 * Hostile prompts: quotes, backslashes, newlines, whitespace, CJK, emoji.
 * The mermaid renderer must keep the graph structure intact for these.
 */
const hostileChar = fc.constantFrom(
  '"',
  "'",
  '\\',
  '\n',
  '\r',
  '\t',
  ' ',
  '-',
  '_',
  'a',
  'Z',
  '0',
  '中',
  '🙂',
);
export const hostileAgentArb: fc.Arbitrary<PlanAgent> = fc.record({
  id: ID,
  task_prompt: fc
    .array(hostileChar, { minLength: 1, maxLength: 30 })
    .map((chars) => chars.join('')),
});

function singletonBatches(
  mode: 'serial',
  agentArb: fc.Arbitrary<PlanAgent>,
): fc.Arbitrary<ExecutionPlan> {
  return fc
    .uniqueArray(agentArb, { selector: (a) => a.id, minLength: 1, maxLength: 8 })
    .map((agents) => ({ execution_mode: mode, batches: agents.map((a) => [a]) }));
}

function singleBatchPlan(
  mode: 'parallel',
  agentArb: fc.Arbitrary<PlanAgent>,
): fc.Arbitrary<ExecutionPlan> {
  return fc
    .uniqueArray(agentArb, { selector: (a) => a.id, minLength: 1, maxLength: 8 })
    .map((agents) => ({ execution_mode: mode, batches: [agents] }));
}

/** Random non-empty partition of a globally-unique agent set. */
function partitionedPlan(agentArb: fc.Arbitrary<PlanAgent>): fc.Arbitrary<ExecutionPlan> {
  return fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 5 }).chain((sizes) => {
    const total = sizes.reduce((a, b) => a + b, 0);
    return fc
      .uniqueArray(agentArb, { selector: (a) => a.id, minLength: total, maxLength: total })
      .map((agents) => {
        const batches: PlanAgent[][] = [];
        let offset = 0;
        for (const size of sizes) {
          batches.push(agents.slice(offset, offset + size));
          offset += size;
        }
        return { execution_mode: 'batched', batches };
      });
  });
}

export const serialPlanArb = singletonBatches('serial', planAgentArb);
export const batchedPlanArb = partitionedPlan(planAgentArb);
export const parallelPlanArb = singleBatchPlan('parallel', planAgentArb);
export const anyPlanArb = fc.oneof(serialPlanArb, batchedPlanArb, parallelPlanArb);

export const hostileBatchedPlanArb = partitionedPlan(hostileAgentArb);
export const hostileAnyPlanArb = fc.oneof(
  singletonBatches('serial', hostileAgentArb),
  partitionedPlan(hostileAgentArb),
  singleBatchPlan('parallel', hostileAgentArb),
);

/** All agent ids of a plan, in batch-major order. */
export function planAgentIds(plan: ExecutionPlan): string[] {
  return plan.batches.flatMap((batch) => batch.map((a) => a.id));
}

/** Batch index of every agent id (forward-edges must point to a later batch). */
export function batchIndexOf(plan: ExecutionPlan): Map<string, number> {
  const index = new Map<string, number>();
  plan.batches.forEach((batch, i) => {
    for (const a of batch) {
      index.set(a.id, i);
    }
  });
  return index;
}
