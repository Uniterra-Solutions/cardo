/**
 * Integrated PBT — Jovaltus pipeline state machine (`dist/state.js`).
 *
 * Business invariants encoded as properties:
 *  1. startPipeline initial state matches the contract: the tool's FIRST
 *     phase per CHAIN, status 'running', loop_iteration 0, verdict null.
 *  2. Domain closure: any sequence of CHAIN-valid setPhase transitions keeps
 *     the pipeline in-domain (phase/status/verdict/loop_iteration), and the
 *     persisted copy on disk equals the in-memory object after every step.
 *  3. Finish semantics: done/failed are sticky and idempotent; error is set
 *     only on failure; a finished pipeline is locked (setPhase/setVerdict
 *     throw).
 *  4. Verdict flow: 'fix' parking + re-dispatch phases never leave the
 *     domain, never touch loop_iteration (that counter lives at the tool
 *     layer), and roundtrip to disk exactly.
 *  5. Corrupt-state recovery: arbitrary junk or malformed shapes in
 *     jovaltus.json make getPipeline() return null (never throw) and reset
 *     to idle; a new pipeline starts clean afterwards.
 *  6. resetPipeline clears only the pipeline key and preserves the rest of
 *     the state file.
 *
 * The agent dir is redirected per test via PI_CODING_AGENT_DIR (pi's
 * getAgentDir() honours it), so the real ~/.pi/agent is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  finishPipeline,
  getPipeline,
  PHASES,
  resetPipeline,
  setPhase,
  setVerdict,
  startPipeline,
  STATUSES,
} from '../../dist/state.js';
import { CHAIN, waitingPhase } from '../../dist/chain.js';
import { makeTmpDir, setAgentDir } from '../helpers/stub-api.mts';

const STATE_FILE = 'jovaltus.json';
const TOOLS = ['plan', 'execute', 'simplify', 'review'] as const;

function freshAgent(agentDir: string): void {
  rmSync(path.join(agentDir, STATE_FILE), { force: true });
}

/** First phase of a tool's CHAIN — the phase startPipeline must begin at. */
function firstPhaseOf(tool: string): string {
  const chain = CHAIN[tool];
  assert.ok(chain !== undefined, `CHAIN has no entry for ${tool}`);
  const first = Object.keys(chain)[0];
  assert.ok(first !== undefined);
  return first;
}

/** Read-back equality through the JSON persistence boundary. */
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

const arbTool = fc.constantFrom(...TOOLS);
const arbRunDir = fc.string({ maxLength: 48 });
const arbRequirements = fc.string({ maxLength: 64 });
const arbPlanPath = fc.oneof(fc.constant(null), fc.string({ maxLength: 48 }));

test('startPipeline: initial state matches the contract for every tool', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    await fc.assert(
      fc.property(
        arbTool,
        arbRunDir,
        arbRequirements,
        arbPlanPath,
        (tool, runDir, req, planPath) => {
          freshAgent(agentDir);
          const p = startPipeline(tool, runDir, req, planPath);
          assert.equal(p.tool, tool);
          assert.equal(p.phase, firstPhaseOf(tool));
          assert.equal(p.status, 'running');
          assert.equal(p.loop_iteration, 0);
          assert.equal(p.verdict, null);
          assert.equal(p.error, null);
          assert.equal(p.run_dir, runDir);
          assert.equal(p.user_requirements, req);
          assert.equal(p.plan_path, planPath);
          assert.ok(!Number.isNaN(Date.parse(p.updated_at)), 'updated_at is an ISO timestamp');
          const disk = getPipeline();
          assert.ok(disk !== null, 'pipeline is persisted');
          assert.deepEqual(normalize(disk), normalize(p));
        },
      ),
    );
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test('domain closure: CHAIN-following transitions keep state in-domain and persisted', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    await fc.assert(
      fc.property(arbTool, fc.integer({ min: 0, max: 6 }), (tool, steps) => {
        freshAgent(agentDir);
        const p = startPipeline(tool, `/repo/.plan/20260101/${tool}`, 'req', null);
        let phase = p.phase;
        for (let i = 0; i < steps; i += 1) {
          const next = CHAIN[tool]?.[phase];
          if (next === undefined || next === 'done') {
            break;
          }
          setPhase(p, next);
          phase = next;
          // In-domain invariants hold after every step.
          assert.ok([...PHASES, 'done'].includes(phase), `phase ${phase} is in-domain`);
          assert.equal(p.status, 'running');
          assert.equal(p.verdict, null);
          assert.equal(p.loop_iteration, 0);
          assert.equal(p.error, null);
          // The disk copy is identical to the in-memory object.
          const disk = getPipeline();
          assert.ok(disk !== null);
          assert.deepEqual(normalize(disk), normalize(p));
        }
      }),
    );
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('finishPipeline: sticky, idempotent, error-on-failure-only, terminal lock', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    await fc.assert(
      fc.property(
        arbTool,
        fc.boolean(),
        fc.oneof(fc.constant(null), fc.string({ maxLength: 80 })),
        (tool, ok, errorText) => {
          freshAgent(agentDir);
          const p = startPipeline(tool, '/run', 'req', null);
          finishPipeline(p, ok, errorText);
          assert.equal(p.status, ok ? 'done' : 'failed');
          assert.equal(p.error, ok ? null : errorText);
          const disk = getPipeline();
          assert.ok(disk !== null);
          assert.deepEqual(normalize(disk), normalize(p));
          // A second finish is a no-op, even with opposite arguments.
          const before = normalize(p);
          finishPipeline(p, !ok, 'second-finish');
          assert.deepEqual(normalize(p), before);
          // Finished pipelines are locked against further mutation.
          assert.throws(() => setPhase(p, firstPhaseOf(tool)));
          assert.throws(() => setVerdict(p, 'pass'));
        },
      ),
    );
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('verdict flow: fix parking + re-dispatch stays in-domain and roundtrips; loop_iteration untouched', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    // A reviewer loop is a (possibly empty) run of fix verdicts followed by
    // a terminating pass — a pass after a finished pipeline would be an
    // invalid sequence, so the generator only produces reachable plans.
    const arbVerdicts = fc
      .array(fc.constant('fix'), { maxLength: 5 })
      .map((fixes) => [...fixes, 'pass']);
    await fc.assert(
      fc.property(fc.constantFrom('simplify', 'review'), arbVerdicts, (tool, verdicts) => {
        freshAgent(agentDir);
        const p = startPipeline(tool, `/repo/.plan/20260101/${tool}`, 'req', null);
        for (const verdict of verdicts) {
          if (verdict === 'fix') {
            // Reviewer found defects: park in the waiting phase (the tool
            // layer increments loop_iteration; the state module must not).
            setVerdict(p, 'fix');
            setPhase(p, waitingPhase(tool));
          } else {
            setVerdict(p, 'pass');
            setPhase(p, 'done');
            finishPipeline(p, true);
          }
          assert.equal(p.loop_iteration, 0, 'state module never increments loop_iteration');
          assert.ok([...PHASES, 'done'].includes(p.phase));
          assert.ok(STATUSES.includes(p.status));
          assert.ok(p.verdict === null || p.verdict === 'pass' || p.verdict === 'fix');
          const disk = getPipeline();
          assert.ok(disk !== null);
          assert.deepEqual(normalize(disk), normalize(p));
        }
      }),
    );
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('corrupt state: arbitrary junk never throws and yields idle', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    await fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (junk) => {
        freshAgent(agentDir);
        writeFileSync(path.join(agentDir, STATE_FILE), junk, 'utf8');
        const p = getPipeline();
        assert.equal(p, null);
        // A fresh pipeline starts cleanly afterwards (the corrupt file is
        // replaced, not appended to).
        const q = startPipeline('plan', '/run', 'req', null);
        assert.equal(q.status, 'running');
        const disk = getPipeline();
        assert.ok(disk !== null);
        assert.equal(disk.tool, 'plan');
      }),
    );
    // Malformed shapes (object roots with bad fields) also yield idle.
    const shapes: unknown[] = [
      { pipeline: [] },
      { pipeline: 'nope' },
      { pipeline: { tool: 'plan' } },
      { pipeline: { run_dir: 5, tool: 'plan' } },
      { pipeline: { run_dir: '/r', tool: 'plan', phase: 'banana', status: 'running' } },
      { pipeline: { run_dir: '/r', tool: 'mystery', phase: 'prd', status: 'running' } },
    ];
    for (const shape of shapes) {
      freshAgent(agentDir);
      writeFileSync(path.join(agentDir, STATE_FILE), JSON.stringify(shape), 'utf8');
      assert.equal(getPipeline(), null, `shape yields idle: ${JSON.stringify(shape)}`);
    }
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('resetPipeline: clears only the pipeline key, preserves other state keys', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    // Seed an unrelated key alongside a pipeline, then reset.
    writeFileSync(path.join(agentDir, STATE_FILE), JSON.stringify({ other: { kept: 1 } }), 'utf8');
    const q = startPipeline('review', '/run2', '', null);
    void q;
    assert.ok(getPipeline() !== null);
    resetPipeline();
    assert.equal(getPipeline(), null, 'pipeline is gone after reset');
    const raw = JSON.parse(readFileSync(path.join(agentDir, STATE_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.deepEqual(raw, { other: { kept: 1 } }, 'unrelated keys survive reset');
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});
