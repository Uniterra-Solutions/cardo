/**
 * PBT spec — execution steps derivation (`dist/plan-steps.js`).
 *
 * `deriveExecutionSteps` maps the batch-major plan to the dispatcher's
 * working shape: an ordered list of concurrent agent-id sets. Business
 * invariants:
 *  1. Total: never throws for any valid plan.
 *  2. Order preservation: flattening steps yields exactly the batch-major
 *     agent-id sequence — steps never reorder work.
 *  3. Mode shapes: serial → N singleton steps; parallel → exactly 1 step;
 *     batched → one step per batch, ids in batch order.
 *  4. No duplication / no loss: ids never repeat across steps and the id set
 *     equals the plan's agent set exactly.
 *  5. Every step is non-empty (nothing runs concurrently with nothing).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { deriveExecutionSteps } from '../../dist/plan-steps.js';
import {
  anyPlanArb,
  batchedPlanArb,
  parallelPlanArb,
  planAgentIds,
  serialPlanArb,
} from '../helpers/plan-gen.mts';

test('total: never throws on any valid plan', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      assert.doesNotThrow(() => deriveExecutionSteps(plan));
    }),
  );
});

test('order preservation: flatten(steps) equals the batch-major id sequence', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const steps = deriveExecutionSteps(plan);
      assert.deepEqual(steps.flat(), planAgentIds(plan));
    }),
  );
});

test('mode shapes: serial → singleton steps, parallel → one step, batched → one step per batch', async () => {
  await fc.assert(
    fc.property(serialPlanArb, (plan) => {
      const steps = deriveExecutionSteps(plan);
      assert.equal(steps.length, planAgentIds(plan).length);
      assert.ok(
        steps.every((step) => step.length === 1),
        'serial steps are singletons',
      );
    }),
  );
  await fc.assert(
    fc.property(parallelPlanArb, (plan) => {
      const steps = deriveExecutionSteps(plan);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.length, planAgentIds(plan).length);
    }),
  );
  await fc.assert(
    fc.property(batchedPlanArb, (plan) => {
      const steps = deriveExecutionSteps(plan);
      assert.equal(steps.length, plan.batches.length);
      plan.batches.forEach((batch, i) => {
        assert.deepEqual(
          steps[i],
          batch.map((a) => a.id),
          `step ${i} mirrors batch ${i}`,
        );
      });
    }),
  );
});

test('no duplication, no loss: every id appears exactly once across steps', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const steps = deriveExecutionSteps(plan);
      const seen = new Set<string>();
      const ids = planAgentIds(plan);
      for (const step of steps) {
        assert.ok(step.length >= 1, 'steps are non-empty');
        for (const id of step) {
          assert.ok(!seen.has(id), `duplicate id ${id} across steps`);
          seen.add(id);
        }
      }
      assert.deepEqual(seen, new Set(ids));
    }),
  );
});
