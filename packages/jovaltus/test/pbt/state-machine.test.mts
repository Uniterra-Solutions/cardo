/**
 * Integrated PBT — Jovaltus pipeline state machine (`dist/state.js`,
 * SQLite session store).
 *
 * Business invariants encoded as properties:
 *  1. startPipeline initial state matches the contract: the tool's FIRST
 *     phase per CHAIN, status 'running', loop_iteration 0, verdict null,
 *     and a unique session id owned by the current process.
 *  2. Domain closure: any sequence of CHAIN-valid setPhase transitions keeps
 *     the pipeline in-domain (phase/status/verdict/loop_iteration), and the
 *     persisted copy in the SQLite store equals the in-memory object after
 *     every step.
 *  3. Finish semantics: done/failed are sticky and idempotent; error is set
 *     only on failure; a finished pipeline is locked (setPhase/setVerdict
 *     throw); interrupted is a third terminal state (markInterrupted is
 *     idempotent and finishPipeline is a no-op on it).
 *  4. Verdict flow: 'fix' parking + re-dispatch phases never leave the
 *     domain, never touch loop_iteration (that counter lives at the tool
 *     layer), and roundtrip to the store exactly.
 *  5. Supersede: starting a new pipeline interrupts any other running
 *     session — only one active pipeline exists.
 *  6. Orphan sweep: a running session owned by a dead pid is interrupted on
 *     the next access (crash/kill recovery).
 *  7. Corrupt-state recovery: an unreadable SQLite file makes getPipeline()
 *     return null (never throw) and a new pipeline starts clean afterwards.
 *  8. History API: listSessions returns every session newest-first;
 *     getSession finds by id or run_dir; resumeSession re-activates only
 *     interrupted/failed sessions and throws on missing/running/done.
 *  9. Legacy migration: a pre-SQLite jovaltus.json pipeline becomes a
 *     session row (running → interrupted).
 *
 * The agent dir is redirected per test via PI_CODING_AGENT_DIR (pi's
 * getAgentDir() honours it), so the real ~/.pi/agent is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  finishPipeline,
  getPipeline,
  getSession,
  listSessions,
  markInterrupted,
  PHASES,
  resumeSession,
  setPhase,
  setVerdict,
  startPipeline,
  STATUSES,
} from '../../dist/state.js';
import { CHAIN, waitingPhase } from '../../dist/chain.js';
import { makeTmpDir, setAgentDir } from '../helpers/stub-api.mts';

const DB_FILE = 'jovaltus.sqlite';
const TOOLS = ['plan', 'execute', 'simplify', 'review'] as const;

/** Empty the sessions table without unlinking the file (the module keeps an
 *  open connection to it, so deleting the file would orphan that handle). */
function freshAgent(agentDir: string): void {
  try {
    const d = new DatabaseSync(path.join(agentDir, DB_FILE));
    try {
      d.exec('DELETE FROM sessions');
    } finally {
      d.close();
    }
  } catch {
    // No DB yet — nothing to clear.
  }
}

/** First phase of a tool's CHAIN — the phase startPipeline must begin at. */
function firstPhaseOf(tool: string): string {
  const chain = CHAIN[tool];
  assert.ok(chain !== undefined, `CHAIN has no entry for ${tool}`);
  const first = Object.keys(chain)[0];
  assert.ok(first !== undefined);
  return first;
}

/** Read-back equality through the SQLite persistence boundary. */
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
          assert.ok(p.id.length > 0, 'session has an id');
          assert.equal(p.pid, process.pid, 'owned by the current process');
          assert.ok(!Number.isNaN(Date.parse(p.updated_at)), 'updated_at is an ISO timestamp');
          assert.equal(p.ended_at, null, 'active sessions have no ended_at');
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
          // The store copy is identical to the in-memory object.
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
          assert.ok(p.ended_at !== null, 'finished sessions record ended_at');
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

test('supersede: starting a new pipeline interrupts the previous running session', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    const first = startPipeline('review', '/repo/.plan/20260101/a', 'req', null);
    setVerdict(first, 'fix');
    setPhase(first, 'review_waiting'); // parked, still running
    const second = startPipeline('plan', '/repo/.plan/20260101/b', 'req2', null);
    assert.equal(second.status, 'running');
    // The superseded session is interrupted on disk (the in-memory object
    // of the old run is stale by design — only the store is authoritative).
    const oldRun = getSession(first.id);
    assert.ok(oldRun !== null);
    assert.equal(oldRun.status, 'interrupted', 'the old run is superseded');
    assert.ok(oldRun.ended_at !== null);
    const disk = getPipeline();
    assert.ok(disk !== null);
    assert.equal(disk.id, second.id, 'the newest running session is active');
    assert.equal(disk.phase, 'prd');
    const sessions = listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.id, second.id);
    assert.equal(sessions[1]?.id, first.id);
    assert.equal(sessions[1]?.status, 'interrupted');
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('markInterrupted: running → interrupted with ended_at; terminal and idempotent', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    const p = startPipeline('plan', '/run', 'req', null);
    markInterrupted(p);
    assert.equal(p.status, 'interrupted');
    assert.equal(p.error, null, 'an interruption is not an error');
    assert.ok(p.ended_at !== null);
    // Idempotent; a finished pipeline cannot be interrupted.
    const before = normalize(p);
    markInterrupted(p);
    assert.deepEqual(normalize(p), before);
    // Interrupted is terminal: finishPipeline is a no-op, mutations throw.
    finishPipeline(p, true, 'late success');
    assert.equal(p.status, 'interrupted');
    assert.throws(() => setPhase(p, 'tasks'));
    // The store agrees.
    const disk = getPipeline();
    assert.ok(disk !== null);
    assert.deepEqual(normalize(disk), normalize(p));
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('orphan sweep: a running session owned by a dead pid is interrupted on next access', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    const p = startPipeline('execute', '/run', 'req', null);
    assert.equal(getPipeline()?.id, p.id, 'active before the owner dies');
    // Simulate a crash/restart: the owning process dies and a NEW process
    // (different pid) opens the store. Rewrite the row's pid to a dead one.
    const d = new DatabaseSync(path.join(agentDir, DB_FILE));
    try {
      d.prepare('UPDATE sessions SET pid = ? WHERE id = ?').run(process.pid + 999999, p.id);
    } finally {
      d.close();
    }
    // The next access sweeps the orphan: it can never masquerade as active.
    const swept = getPipeline();
    assert.ok(swept !== null);
    assert.equal(swept.status, 'interrupted');
    assert.equal(swept.id, p.id);
    const orphan = getSession(p.id);
    assert.ok(orphan !== null);
    assert.equal(orphan.status, 'interrupted');
    assert.ok(orphan.ended_at !== null);
    assert.equal(orphan.error, null);
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('history API: listSessions newest-first, getSession by id or run_dir', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);
    assert.deepEqual(listSessions(), [], 'empty store lists nothing');
    const plan = startPipeline('plan', '/repo/.plan/20260101/a', 'first', null);
    finishPipeline(plan, true);
    const review = startPipeline('review', '/repo/.plan/20260101/b', '', null);
    setVerdict(review, 'fix');
    setPhase(review, 'review_waiting');
    const shared = startPipeline('review', '/repo/.plan/20260101/shared', '', null);
    finishPipeline(shared, true);

    const sessions = listSessions();
    assert.equal(sessions.length, 3);
    assert.equal(sessions[0]?.id, shared.id, 'newest first');
    assert.equal(sessions[1]?.id, review.id);
    assert.equal(sessions[2]?.id, plan.id);

    assert.equal(getSession(plan.id)?.run_dir, '/repo/.plan/20260101/a', 'lookup by id');
    assert.equal(getSession('/repo/.plan/20260101/b')?.id, review.id, 'lookup by run_dir');
    assert.equal(
      getSession('/repo/.plan/20260101/shared')?.id,
      shared.id,
      'run_dir lookup returns the newest match',
    );
    assert.equal(getSession('no-such-session'), null);
    assert.equal(getSession(''), null);
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('resumeSession: re-activates interrupted/failed, throws on running/done/missing', async () => {
  const agentDir = makeTmpDir();
  try {
    setAgentDir(agentDir);

    // Interrupted → running again, owned by this process, error cleared.
    const interrupted = startPipeline('plan', '/run/1', 'req', null);
    markInterrupted(interrupted);
    const resumed1 = resumeSession(interrupted.id);
    assert.equal(resumed1.status, 'running');
    assert.equal(resumed1.error, null);
    assert.equal(resumed1.ended_at, null);
    assert.equal(resumed1.pid, process.pid);
    assert.equal(resumed1.id, interrupted.id, 'resume keeps the session identity');
    assert.deepEqual(normalize(getPipeline()), normalize(resumed1), 'resume persists');

    // Failed → running again.
    const failed = startPipeline('execute', '/run/2', '', null);
    finishPipeline(failed, false, 'boom');
    const resumed2 = resumeSession(failed.id);
    assert.equal(resumed2.status, 'running');
    assert.equal(resumed2.error, null);

    // Running → throws.
    const running = startPipeline('review', '/run/3', '', null);
    assert.throws(() => resumeSession(running.id), /already running/);

    // Done → throws.
    const done = startPipeline('simplify', '/run/4', '', null);
    finishPipeline(done, true);
    assert.throws(() => resumeSession(done.id), /already completed/);

    // Missing → throws.
    assert.throws(() => resumeSession('ghost'), /no Jovaltus session/);
  } finally {
    setAgentDir(makeTmpDir('jovaltus-cleanup-'));
  }
});

test('corrupt store: an unreadable SQLite file never throws and yields idle', async () => {
  await fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (junk) => {
      // A FRESH agent dir per iteration: the module caches its connection by
      // path, and a corrupted file must be recovered from a cold open.
      const agentDir = makeTmpDir('jovaltus-corrupt-');
      try {
        setAgentDir(agentDir);
        writeFileSync(path.join(agentDir, DB_FILE), junk, 'utf8');
        const p = getPipeline();
        assert.equal(p, null);
        // A fresh pipeline starts cleanly afterwards (the corrupt file is
        // replaced, not appended to).
        const q = startPipeline('plan', '/run', 'req', null);
        assert.equal(q.status, 'running');
        const disk = getPipeline();
        assert.ok(disk !== null);
        assert.equal(disk.tool, 'plan');
      } finally {
        rmSync(agentDir, { recursive: true, force: true });
      }
    }),
  );
});

test('migration: a legacy jovaltus.json pipeline becomes a session row', () => {
  const legacyPipeline = {
    run_dir: '/repo/.plan/20260101/old',
    tool: 'plan',
    phase: 'research',
    user_requirements: 'Old run',
    plan_path: null,
    loop_iteration: 0,
    verdict: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    error: null,
  };

  // A legacy "running" pipeline: its owner is gone — recorded interrupted.
  const runningDir = makeTmpDir('jovaltus-migrate-running-');
  try {
    setAgentDir(runningDir);
    writeFileSync(
      path.join(runningDir, 'jovaltus.json'),
      JSON.stringify({ pipeline: { ...legacyPipeline, status: 'running' }, other: { kept: 1 } }),
      'utf8',
    );
    const p = getPipeline();
    assert.ok(p !== null);
    assert.equal(p.status, 'interrupted', 'a running legacy pipeline migrates as interrupted');
    assert.equal(p.phase, 'research');
    assert.equal(p.run_dir, '/repo/.plan/20260101/old');
    assert.equal(p.tool, 'plan');
    assert.ok(p.ended_at !== null);
    assert.equal(listSessions().length, 1, 'migration runs only once');
  } finally {
    rmSync(runningDir, { recursive: true, force: true });
  }

  // A legacy "done" pipeline: status preserved, ended_at back-filled.
  const doneDir = makeTmpDir('jovaltus-migrate-done-');
  try {
    setAgentDir(doneDir);
    writeFileSync(
      path.join(doneDir, 'jovaltus.json'),
      JSON.stringify({
        pipeline: { ...legacyPipeline, status: 'done', phase: 'done' },
      }),
      'utf8',
    );
    const p = getPipeline();
    assert.ok(p !== null);
    assert.equal(p.status, 'done');
    assert.equal(p.phase, 'done');
  } finally {
    rmSync(doneDir, { recursive: true, force: true });
  }
});
