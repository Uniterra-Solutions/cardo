/**
 * PBT spec — execution plan schema (`dist/plan.js`).
 *
 * The plan agent's output is untrusted JSON; `parseExecutionPlan` must be
 * total (never throw) and canonical. Business invariants:
 *  1. Total: arbitrary JSON never throws; results are canonical or null.
 *  2. Round-trip: every valid plan persisted (JSON) and re-read parses back
 *     deep-equal — the stored artifact and the runtime object agree.
 *  3. Shape constraints: mode dictates batch structure — serial → singleton
 *     batches, parallel → exactly one batch, batched → non-empty batches;
 *     ids are globally unique and mermaid-safe; task_prompts non-blank.
 *  4. Rejection: structural violations (duplicate ids, empty batch, bad mode,
 *     wrong shape for mode, unsafe ids, blank prompts) → null, never throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { agentCount, parseExecutionPlan, type ExecutionPlan } from '../../dist/plan.js';
import {
  anyPlanArb,
  batchedPlanArb,
  parallelPlanArb,
  serialPlanArb,
} from '../helpers/plan-gen.mts';

function assertCanonical(plan: ExecutionPlan): void {
  assert.ok(
    plan.execution_mode === 'serial' ||
      plan.execution_mode === 'batched' ||
      plan.execution_mode === 'parallel',
    `mode ${plan.execution_mode} must be one of serial/batched/parallel`,
  );
  assert.ok(plan.batches.length >= 1, 'at least one batch');
  const ids = new Set<string>();
  for (const batch of plan.batches) {
    assert.ok(batch.length >= 1, 'no empty batch');
    for (const agent of batch) {
      assert.match(agent.id, /^[A-Za-z0-9_-]+$/, `id ${agent.id} must be mermaid-safe`);
      assert.ok(agent.task_prompt.trim().length > 0, 'task_prompt must be non-blank');
      assert.ok(!ids.has(agent.id), `ids must be globally unique (dup: ${agent.id})`);
      ids.add(agent.id);
    }
  }
  if (plan.execution_mode === 'serial') {
    assert.ok(
      plan.batches.every((b) => b.length === 1),
      'serial: every batch holds exactly one agent',
    );
  }
  if (plan.execution_mode === 'parallel') {
    assert.equal(plan.batches.length, 1, 'parallel: exactly one batch');
  }
}

test('total: arbitrary JSON never throws; result is canonical or null', async () => {
  await fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = parseExecutionPlan(value);
      });
      if (parsed !== null) {
        assertCanonical(parsed as ExecutionPlan);
      }
    }),
    { numRuns: 2000 },
  );
});

test('round-trip: valid plans persist and parse back deep-equal', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      // the persisted artifact is what the parser must reproduce exactly
      const persisted = JSON.parse(JSON.stringify(plan)) as unknown;
      const parsed = parseExecutionPlan(persisted);
      assert.deepEqual(parsed, persisted);
      assert.equal(agentCount(parsed as ExecutionPlan), plan.batches.flat().length);
    }),
  );
});

test('shape constraints: serial singletons, parallel single batch, batched non-empty', async () => {
  await fc.assert(fc.property(serialPlanArb, (plan) => assertCanonical(plan)));
  await fc.assert(fc.property(batchedPlanArb, (plan) => assertCanonical(plan)));
  await fc.assert(fc.property(parallelPlanArb, (plan) => assertCanonical(plan)));
});

test('rejection: structural violations parse to null without throwing', async () => {
  const valid = {
    execution_mode: 'batched',
    batches: [[{ id: 'A', task_prompt: 'x' }]],
  };
  const cases: unknown[] = [
    null,
    42,
    'plan',
    [],
    {},
    { execution_mode: 'weird', batches: [[{ id: 'A', task_prompt: 'x' }]] },
    { execution_mode: 'batched', batches: [] },
    { execution_mode: 'batched', batches: [[]] },
    { execution_mode: 'batched', batches: [[{ id: 'A', task_prompt: 'x' }], []] },
    { execution_mode: 'batched', batches: [[{ id: 'A', task_prompt: '' }]] },
    { execution_mode: 'batched', batches: [[{ id: 'A', task_prompt: '   ' }]] },
    {
      execution_mode: 'batched',
      batches: [
        [
          { id: 'A', task_prompt: 'x' },
          { id: 'A', task_prompt: 'y' },
        ],
      ],
    },
    { execution_mode: 'batched', batches: [[{ id: 'a b', task_prompt: 'x' }]] },
    { execution_mode: 'batched', batches: [[{ id: 'A"B', task_prompt: 'x' }]] },
    { execution_mode: 'batched', batches: [[{ id: 'A' }]] },
    { execution_mode: 'batched', batches: [[{ task_prompt: 'x' }]] },
    {
      execution_mode: 'serial',
      batches: [
        [
          { id: 'A', task_prompt: 'x' },
          { id: 'B', task_prompt: 'y' },
        ],
      ],
    },
    {
      execution_mode: 'serial',
      batches: [
        [{ id: 'A', task_prompt: 'x' }],
        [{ id: 'B', task_prompt: 'y' }],
        [
          { id: 'C', task_prompt: 'z' },
          { id: 'D', task_prompt: 'w' },
        ],
      ],
    },
    {
      execution_mode: 'parallel',
      batches: [[{ id: 'A', task_prompt: 'x' }], [{ id: 'B', task_prompt: 'y' }]],
    },
    { execution_mode: 'serial', batches: [] },
    { execution_mode: 'batched', batches: 'nope' },
  ];
  for (const input of cases) {
    let result: unknown;
    assert.doesNotThrow(
      () => {
        result = parseExecutionPlan(input);
      },
      `must not throw for ${JSON.stringify(input)}`,
    );
    assert.equal(result, null, `must reject ${JSON.stringify(input)}`);
  }
  // sanity: the template itself is valid
  assert.deepEqual(parseExecutionPlan(valid), valid);
});

test('rejection: arbitrary mutations of a valid plan never throw', async () => {
  await fc.assert(
    fc.property(anyPlanArb, fc.jsonValue(), (plan, junk) => {
      const mutations: unknown[] = [
        { ...plan, execution_mode: junk },
        { ...plan, batches: junk },
        { ...plan, batches: [] },
        plan.batches.map(() => junk),
      ];
      for (const mutated of mutations) {
        assert.doesNotThrow(() => parseExecutionPlan(mutated));
      }
    }),
  );
});
