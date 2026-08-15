/**
 * PBT spec — execution progress machine (`dist/plan-progress.js`).
 *
 * The status machine drives dispatch gating AND the execute panel's lights.
 * Business invariants:
 *  1. Fresh state: every agent starts `pending`; a non-empty plan is never
 *     complete.
 *  2. Batch gating: `agentsToRun` returns only `pending` ids of the earliest
 *     batch that is not fully done — an agent can start only when every agent
 *     of every earlier batch is done.
 *  3. Strict transitions: `startRunning` accepts exactly `agentsToRun`
 *     (no duplicates, no foreign/done ids); `markDone` accepts only `running`
 *     ids. Violations throw and the machine stays untouched.
 *  4. Immutability: transitions return new state; the previous snapshot is
 *     deep-equal before/after.
 *  5. Greedy termination: the loop { start all agentsToRun → mark each done }
 *     always terminates — one step per batch, every agent started and done
 *     exactly once, ending complete.
 *  6. Concurrency cap: every started set lies within a single batch (never
 *     two batches at once).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { anyPlanArb, planAgentIds } from '../helpers/plan-gen.mts';
import {
  agentsToRun,
  createProgress,
  isComplete,
  markDone,
  startRunning,
  type PlanProgress,
} from '../../dist/plan-progress.js';
import type { ExecutionPlan } from '../../dist/plan.js';

function batchIndexOf(plan: ExecutionPlan): Map<string, number> {
  const index = new Map<string, number>();
  plan.batches.forEach((batch, i) => {
    for (const a of batch) {
      index.set(a.id, i);
    }
  });
  return index;
}

/** Simulates a real run: start whatever may run, finish it, repeat. */
function runGreedy(plan: ExecutionPlan): {
  steps: string[][];
  started: Set<string>;
  done: Set<string>;
  history: PlanProgress[];
} {
  let progress = createProgress(plan);
  const steps: string[][] = [];
  const started = new Set<string>();
  const done = new Set<string>();
  const history: PlanProgress[] = [progress];
  const total = planAgentIds(plan).length;
  const batchOf = batchIndexOf(plan);

  for (let iter = 0; iter <= total + 1; iter++) {
    if (isComplete(progress)) {
      break;
    }
    const toStart = agentsToRun(progress);
    assert.ok(toStart.length > 0, `greedy loop must always find work (iter ${iter})`);

    // concurrency cap: the whole set belongs to one batch
    const batchIdx = new Set(toStart.map((id) => batchOf.get(id)));
    assert.equal(batchIdx.size, 1, 'started set must lie within a single batch');

    const snapshot = progress;
    progress = startRunning(progress, toStart);
    assert.notEqual(progress, snapshot, 'transition must return a new object');
    steps.push(toStart);
    for (const id of toStart) {
      assert.ok(!started.has(id), `agent ${id} started twice`);
      started.add(id);
      progress = markDone(progress, id);
      done.add(id);
    }
    history.push(progress);
  }
  return { steps, started, done, history };
}

test('fresh state: all pending, non-empty plan is incomplete', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const progress = createProgress(plan);
      assert.equal(isComplete(progress), false);
      assert.deepEqual(
        new Set([...progress.statuses.values()]),
        new Set(['pending']),
        'every agent starts pending',
      );
      assert.deepEqual(
        progress.batches,
        plan.batches.map((b) => b.map((a) => a.id)),
      );
    }),
  );
});

test('batch gating: agentsToRun is pending ids of the earliest unfinished batch', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const batchOf = batchIndexOf(plan);
      const { history, steps } = runGreedy(plan);
      // after step k, the earliest unfinished batch is k+1 (or complete)
      steps.forEach((step, k) => {
        const state = history[k + 1];
        assert.ok(state !== undefined);
        const next = agentsToRun(state);
        for (const id of next) {
          assert.equal(batchOf.get(id), k + 1, `step ${k + 1} may only start batch ${k + 1} ids`);
        }
        for (const doneId of step) {
          assert.equal(state.statuses.get(doneId), 'done');
        }
      });
      // complete state offers no work
      assert.deepEqual(agentsToRun(history[history.length - 1] as PlanProgress), []);
    }),
  );
});

test('greedy run: one step per batch, every agent started and done exactly once, ends complete', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const { steps, started, done, history } = runGreedy(plan);
      const ids = planAgentIds(plan);
      assert.equal(steps.length, plan.batches.length, 'one step per batch');
      assert.deepEqual(started, new Set(ids));
      assert.deepEqual(done, new Set(ids));
      const final = history[history.length - 1] as PlanProgress;
      assert.equal(isComplete(final), true);
      assert.deepEqual(
        [...final.statuses.values()].every((s) => s === 'done'),
        true,
      );
    }),
  );
});

test('immutability: transitions never mutate the previous snapshot', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const before = createProgress(plan);
      const snapshot = new Map(before.statuses);
      const toStart = agentsToRun(before);
      const afterStart = startRunning(before, toStart);
      assert.deepEqual(before.statuses, snapshot, 'startRunning must not mutate the input');
      const afterDone = markDone(afterStart, toStart[0] as string);
      assert.equal(before.statuses.get(toStart[0] as string), 'pending');
      assert.equal(afterDone.statuses.get(toStart[0] as string), 'done');
    }),
  );
});

test('strict transitions: invalid startRunning / markDone throw without corrupting state', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const fresh = createProgress(plan);
      // markDone on a fresh machine: nothing is running
      assert.throws(() => markDone(fresh, planAgentIds(plan)[0] as string));
      // startRunning with a foreign id is rejected
      assert.throws(() => startRunning(fresh, ['__no_such_agent__']));
      // startRunning with duplicates is rejected
      const toStart = agentsToRun(fresh);
      if (toStart.length > 1) {
        assert.throws(() => startRunning(fresh, [toStart[0] as string, toStart[0] as string]));
      }
      // startRunning with an empty set is rejected
      assert.throws(() => startRunning(fresh, []));
      // after starting, a pending sibling cannot be marked done
      if (toStart.length > 0) {
        const running = startRunning(fresh, toStart);
        const sibling = planAgentIds(plan).find((id) => !toStart.includes(id));
        if (sibling !== undefined) {
          assert.throws(() => markDone(running, sibling));
        }
      }
    }),
  );
});

test('no self-referential state: statuses keyed exactly by plan agents', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      const { history } = runGreedy(plan);
      const ids = new Set(planAgentIds(plan));
      for (const state of history) {
        assert.deepEqual(
          new Set(state.statuses.keys()),
          ids,
          'statuses cover exactly the plan agents',
        );
      }
    }),
  );
});
