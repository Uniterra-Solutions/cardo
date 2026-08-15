/**
 * Integrated PBT — Jovaltus phase chains and verdict readers (`dist/chain.js`).
 *
 * Business invariants encoded as properties:
 *  1. CHAIN closure: every edge target is a real phase or 'done'; every
 *     tool's chain starts at the phase startPipeline must begin at; plan and
 *     execute chains terminate at 'done'; simplify/review chains deliberately
 *     oscillate phase ↔ waiting-phase (termination is verdict-driven, not
 *     chain-driven) — locking that contract.
 *  2. waitingPhase consistency: the parking phase is exactly CHAIN's loop
 *     edge back to the tool phase; only reviewer tools have one.
 *  3. Verdict readers are total: arbitrary run-dir contents (missing file,
 *     invalid JSON, wrong shapes, non-string fields) never throw and yield
 *     deterministic fallbacks (null verdict / empty findings).
 *  4. Verdict roundtrip: {verdict, findings} written by a reviewer is read
 *     back exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { PHASES } from '../../dist/state.js';
import {
  CHAIN,
  readFindings,
  readVerdict,
  WAITING_PHASES,
  waitingPhase,
} from '../../dist/chain.js';
import { makeTmpDir } from '../helpers/stub-api.mts';

const TOOLS = Object.keys(CHAIN);
const VALID_PHASES = [...PHASES, 'done'];

test('CHAIN closure: every edge lands in-domain', async () => {
  await fc.assert(
    fc.property(fc.constantFrom(...TOOLS), (tool) => {
      const chain = CHAIN[tool];
      assert.ok(chain !== undefined);
      for (const [from, to] of Object.entries(chain)) {
        assert.ok(
          VALID_PHASES.includes(to),
          `CHAIN[${tool}][${from}] -> ${to} must be a real phase or done`,
        );
        assert.ok(
          VALID_PHASES.includes(from),
          `CHAIN[${tool}] key ${from} must be a real phase or done`,
        );
      }
    }),
  );
});

test('chains: plan parks at plan_waiting; execute terminates at done; simplify/review oscillate and are verdict-driven', () => {
  // Plan chain parks in plan_waiting: prd → design → plan_waiting. Completion
  // is artifact-driven (agent_settled verifies execution-plan.json), so the
  // chain deliberately has no edge past the parking phase.
  const planChain = CHAIN['plan'];
  assert.ok(planChain !== undefined);
  assert.equal(planChain['prd'], 'design');
  assert.equal(planChain['design'], 'plan_waiting');
  assert.equal(Object.keys(planChain).length, 2, 'no chain edge past the parking phase');
  assert.ok(WAITING_PHASES.includes('plan_waiting'));

  // Execute chain is acyclic and reaches 'done'.
  const executeChain = CHAIN['execute'];
  assert.ok(executeChain !== undefined);
  let phase = Object.keys(executeChain)[0];
  const visited = new Set<string>();
  let reachedDone = false;
  while (phase !== undefined && !visited.has(phase)) {
    visited.add(phase);
    const next = executeChain[phase];
    if (next === 'done') {
      reachedDone = true;
      break;
    }
    phase = next;
  }
  assert.ok(reachedDone, 'execute chain terminates at done');
  // Simplify/review chains have NO done edge: the reviewer verdict ('pass')
  // is what terminates the loop, injected by the tool layer. The chain only
  // alternates phase ↔ waiting phase.
  for (const tool of ['simplify', 'review']) {
    const chain = CHAIN[tool];
    assert.ok(chain !== undefined);
    assert.ok(!Object.values(chain).includes('done'), `${tool} chain has no done edge`);
    const waiting = waitingPhase(tool);
    assert.equal(chain[tool], waiting, `${tool} parks in its waiting phase`);
    assert.equal(chain[waiting], tool, `${tool} re-dispatches from its waiting phase`);
    assert.ok(WAITING_PHASES.includes(waiting));
  }
});

test('waitingPhase: only reviewer tools have a waiting phase', () => {
  assert.equal(waitingPhase('simplify'), 'simplify_waiting');
  assert.equal(waitingPhase('review'), 'review_waiting');
  assert.throws(() => waitingPhase('plan'));
  assert.throws(() => waitingPhase('execute'));
  assert.throws(() => waitingPhase('mystery'));
});

test('readVerdict: total over arbitrary file contents, exact over the valid domain', async () => {
  const runDir = makeTmpDir();
  try {
    await fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.string({ maxLength: 256 }),
          fc.record({ verdict: fc.constantFrom('pass', 'fix', 'banana', 7, null) }),
          fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }),
        ),
        (contents) => {
          mkdirSync(runDir, { recursive: true });
          rmSync(path.join(runDir, 'verdict.json'), { force: true });
          if (contents !== null) {
            writeFileSync(
              path.join(runDir, 'verdict.json'),
              typeof contents === 'string' ? contents : JSON.stringify(contents),
              'utf8',
            );
          }
          const verdict = readVerdict({ run_dir: runDir, tool: 'review' } as never);
          assert.ok(
            verdict === null || verdict === 'pass' || verdict === 'fix',
            `verdict domain: got ${String(verdict)}`,
          );
        },
      ),
    );
    // Deterministic domain cases (locked, not generated).
    const cases: Array<{ contents: unknown; expected: string | null }> = [
      { contents: null, expected: null },
      { contents: 'not json', expected: null },
      { contents: '[]', expected: null },
      { contents: '{}', expected: null },
      { contents: { verdict: 'pass' }, expected: 'pass' },
      { contents: { verdict: 'fix' }, expected: 'fix' },
      { contents: { verdict: 'banana' }, expected: null },
      { contents: { verdict: 7 }, expected: null },
      { contents: { verdict: 'pass', findings: 'x' }, expected: 'pass' },
    ];
    for (const c of cases) {
      rmSync(path.join(runDir, 'verdict.json'), { force: true });
      if (c.contents !== null) {
        writeFileSync(
          path.join(runDir, 'verdict.json'),
          typeof c.contents === 'string' ? c.contents : JSON.stringify(c.contents),
          'utf8',
        );
      }
      assert.equal(
        readVerdict({ run_dir: runDir, tool: 'review' } as never),
        c.expected,
        `verdict.json=${JSON.stringify(c.contents)}`,
      );
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('readFindings: total, falls back to empty string, never throws', async () => {
  const runDir = makeTmpDir();
  try {
    await fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.string({ maxLength: 128 }),
          fc.record({ findings: fc.anything() }),
        ),
        (contents) => {
          mkdirSync(runDir, { recursive: true });
          rmSync(path.join(runDir, 'verdict.json'), { force: true });
          if (contents !== null) {
            writeFileSync(
              path.join(runDir, 'verdict.json'),
              typeof contents === 'string' ? contents : JSON.stringify(contents),
              'utf8',
            );
          }
          const findings = readFindings({ run_dir: runDir, tool: 'review' } as never);
          assert.equal(typeof findings, 'string');
        },
      ),
    );
    assert.equal(readFindings({ run_dir: runDir, tool: 'review' } as never), '');
    writeFileSync(
      path.join(runDir, 'verdict.json'),
      JSON.stringify({ findings: 'defect A' }),
      'utf8',
    );
    assert.equal(readFindings({ run_dir: runDir, tool: 'review' } as never), 'defect A');
    writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify({ findings: 42 }), 'utf8');
    assert.equal(readFindings({ run_dir: runDir, tool: 'review' } as never), '');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('verdict roundtrip: what a reviewer writes, the readers read back exactly', async () => {
  const runDir = makeTmpDir();
  try {
    await fc.assert(
      fc.property(
        fc.constantFrom('pass', 'fix'),
        fc.string({ maxLength: 200 }),
        (verdict, findings) => {
          writeFileSync(
            path.join(runDir, 'verdict.json'),
            JSON.stringify({ verdict, findings }),
            'utf8',
          );
          const p = { run_dir: runDir, tool: 'review' } as never;
          assert.equal(readVerdict(p), verdict);
          assert.equal(readFindings(p), findings);
        },
      ),
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
