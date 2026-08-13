/**
 * Integrated PBT — the full Jovaltus tool surface against the fake `pi`
 * backend (`dist/index.js` factory + tool handlers + event hooks).
 *
 * These are the end-to-end business invariants: the extension factory
 * registers exactly the six pipeline tools; every tool handler drives real
 * child dispatches through the backend and advances the persisted pipeline
 * state exactly as the business rules say; the `agent_settled` hook closes
 * the verdict-driven review loop; `list_sessions` reports the persisted
 * history; `resume_session` re-activates interrupted/failed sessions; an
 * aborted or ended run is recorded as `interrupted`, never `failed`.
 *
 * Invariants locked here:
 *  1. plan: dispatches exactly CHAIN['plan']'s phases in order (the
 *     handler's hardcoded phase list must not drift from the chain table),
 *     ends done, and the run dir follows <cwd>/.plan/<date>/<slug>/.
 *     A mid-chain backend failure fails the pipeline with the phase named.
 *  2. execute: run dir is the plan's directory; execute → done; a missing
 *     plan path errors before any pipeline is started.
 *  3. review/simplify: 'pass' on round 1 → done; 'fix' parks the pipeline in
 *     the waiting phase with loop_iteration +1 and the findings surfaced;
 *     each `agent_settled` round consumes one verdict — fix keeps parking
 *     (no cap), pass finishes and notifies; verdict.json missing/invalid
 *     fails deterministically.
 *  4. agent_settled is a no-op outside a running *waiting pipeline (idle,
 *     finished, non-waiting phase, non-reviewer tool).
 *  5. before_agent_start injects the pipeline status into every turn (and
 *     nothing when idle); the plan-complete summary names tasks.md.
 *  6. MODEL-BASED property over random verdict plans: after any fix/pass
 *     sequence ending in pass, loop_iteration == fix count, user messages ==
 *     fix rounds consumed by agent_settled, and the terminal state is done +
 *     verdict pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as fc from 'fast-check';
import jovaltusFactory from '../../dist/index.js';
import { getPipeline, setPhase, startPipeline, finishPipeline } from '../../dist/state.js';
import type { PipelineState } from '../../dist/state.js';
import { CHAIN } from '../../dist/chain.js';
import {
  captureApi,
  clearFakeEnv,
  freshFakeEnv,
  makeCtx,
  makeTmpDir,
  setAgentDir,
  useVerdictPlan,
} from '../helpers/stub-api.mts';
import type { CapturedTool, StubApi, ToolCallResult } from '../helpers/stub-api.mts';

interface FakeLogEntry {
  argv: string[];
  tool: string | null;
  phase: string | null;
  runDir: string | null;
  promptFile: string | null;
  prompt: string;
  output: string;
  cwd: string;
  promptMode: number | null;
  exitCode: number;
}

function readFakeLog(logFile: string): FakeLogEntry[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

/** Fresh tmp workspace + agent dir + captured extension factory. */
function setupRun(t: { after(fn: () => void): void }): {
  tmp: string;
  cwd: string;
  stub: StubApi;
  logFile: string;
} {
  const tmp = makeTmpDir();
  t.after(() => {
    clearFakeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });
  const cwd = path.join(tmp, 'repo');
  mkdirSync(cwd, { recursive: true });
  setAgentDir(path.join(tmp, 'agent'));
  const logFile = freshFakeEnv(tmp, { JOVALTUS_FAKE_OUTPUT: 'phase executed' });
  const stub = captureApi();
  jovaltusFactory(stub.api);
  return { tmp, cwd, stub, logFile };
}

function requireTool(stub: StubApi, name: string): CapturedTool {
  const tool = stub.tools.get(name);
  assert.ok(tool !== undefined, `factory registered ${name}`);
  return tool;
}

async function callTool(
  stub: StubApi,
  name: string,
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolCallResult> {
  const tool = requireTool(stub, name);
  const { ctx } = makeCtx(cwd);
  return (await tool.execute('call-1', params, undefined, undefined, ctx)) as ToolCallResult;
}

function currentPipeline(): PipelineState {
  const p = getPipeline();
  assert.ok(p !== null, 'a pipeline is active');
  return p;
}

// ---- plan -----------------------------------------------------------------

test('plan: dispatches CHAIN[plan] phases in order, ends done, run dir is <cwd>/.plan/<date>/<slug>/', async (t) => {
  const { tmp, cwd, stub, logFile } = setupRun(t);
  const result = await callTool(stub, 'plan', { user_requirements: 'Fix the login flow' }, cwd);
  assert.ok(!result.details['isError'], 'plan succeeds');
  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('plan pipeline complete: phase tasks finished'), 'completion text');
  const runDir = result.details['run_dir'];
  assert.equal(typeof runDir, 'string');
  assert.ok(String(runDir).startsWith(path.join(cwd, '.plan')), 'run dir under cwd/.plan');
  assert.ok(/\.plan[\\/]\d{8}[\\/]fix-the-login-flow/.test(String(runDir)), 'slugified run dir');

  // The backend saw exactly the chain's phases, in order, with the right marker.
  const dispatched = readFakeLog(logFile).map((e) => e.phase);
  assert.deepEqual(dispatched, Object.keys(CHAIN['plan'] ?? {}), 'dispatches CHAIN[plan] in order');
  for (const entry of readFakeLog(logFile)) {
    assert.equal(entry.tool, 'plan');
  }

  // Terminal pipeline state.
  const p = currentPipeline();
  assert.equal(p.tool, 'plan');
  assert.equal(p.phase, 'done');
  assert.equal(p.status, 'done');
  assert.equal(p.verdict, null);
  assert.equal(p.loop_iteration, 0);
  assert.equal(p.error, null);
  assert.equal(p.user_requirements, 'Fix the login flow');
  assert.equal(p.run_dir, runDir);
  assert.equal(p.plan_path, null);
  void tmp;
});

test('plan: a mid-chain backend failure fails the pipeline at the failing phase', async (t) => {
  const { cwd, stub } = setupRun(t);
  process.env.JOVALTUS_FAKE_FAIL_ON = 'research';
  const result = await callTool(stub, 'plan', { user_requirements: 'Do a thing' }, cwd);
  assert.equal(result.details['isError'], true, 'plan reports failure');
  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('phase research failed (exit 1)'), `names the failing phase: ${text}`);
  const p = currentPipeline();
  assert.equal(p.status, 'failed');
  assert.equal(p.phase, 'research', 'failure parks at the phase that failed');
  assert.ok(
    p.error !== null && p.error.includes('phase research failed'),
    'error message persisted',
  );
});

test('plan: empty user_requirements errors before any pipeline starts', async (t) => {
  const { cwd, stub } = setupRun(t);
  const result = await callTool(stub, 'plan', { user_requirements: '   ' }, cwd);
  assert.equal(result.details['isError'], true);
  assert.equal(getPipeline(), null, 'no pipeline started');
});

// ---- execute ---------------------------------------------------------------

test('execute: run dir is the plan directory, execute → done', async (t) => {
  const { tmp, cwd, stub, logFile } = setupRun(t);
  const planPath = path.join(tmp, 'plans', 'tasks.md');
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# Tasks\n', 'utf8');
  const result = await callTool(stub, 'execute', { plan: planPath }, cwd);
  assert.ok(!result.details['isError']);
  const dispatched = readFakeLog(logFile).map((e) => e.phase);
  assert.deepEqual(dispatched, ['execute']);
  const p = currentPipeline();
  assert.equal(p.tool, 'execute');
  assert.equal(p.phase, 'done');
  assert.equal(p.status, 'done');
  assert.equal(p.run_dir, path.dirname(planPath));
  assert.equal(p.plan_path, planPath);
});

test('execute: missing plan path errors before any pipeline starts', async (t) => {
  const { cwd, stub } = setupRun(t);
  const result = await callTool(stub, 'execute', { plan: '/nonexistent/tasks.md' }, cwd);
  assert.equal(result.details['isError'], true);
  assert.ok((result.content[0]?.text ?? '').includes('plan path does not exist'));
  assert.equal(getPipeline(), null);
});

// ---- review / simplify + the agent_settled loop ----------------------------

test('review: pass on round 1 finishes immediately', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  useVerdictPlan(tmp, ['pass']);
  const result = await callTool(stub, 'review', {}, cwd);
  assert.ok(!result.details['isError']);
  assert.equal(result.details['verdict'], undefined, 'no fix verdict on pass');
  const p = currentPipeline();
  assert.equal(p.tool, 'review');
  assert.equal(p.phase, 'done');
  assert.equal(p.status, 'done');
  assert.equal(p.verdict, 'pass');
  assert.equal(p.loop_iteration, 0);
  assert.equal(stub.sentMessages.length, 0, 'no wake message on a pass');
});

test('review: fix parks in review_waiting; agent_settled re-dispatches until pass', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  const verdictFile = useVerdictPlan(tmp, ['fix', 'fix', 'pass']);
  process.env.JOVALTUS_FAKE_FINDINGS = 'found a defect';

  // Round 1 (tool call): fix.
  const round1 = await callTool(stub, 'review', {}, cwd);
  assert.equal(round1.details['verdict'], 'fix');
  assert.ok((round1.content[0]?.text ?? '').includes('review round 1: reviewer found defects'));
  assert.ok((round1.content[0]?.text ?? '').includes('found a defect'), 'findings surfaced');
  let p = currentPipeline();
  assert.equal(p.phase, 'review_waiting');
  assert.equal(p.status, 'running');
  assert.equal(p.verdict, 'fix');
  assert.equal(p.loop_iteration, 1);
  assert.equal(stub.sentMessages.length, 0, 'tool call itself does not wake the agent');

  // Simulate the main agent fixing, then agent_settled re-dispatches.
  const settled = stub.handlers.get('agent_settled');
  assert.ok(settled !== undefined, 'factory registered agent_settled');
  const { ctx, notifications } = makeCtx(cwd);
  await settled({}, ctx);

  // Round 2 (settled): fix again — park, wake the main agent.
  p = currentPipeline();
  assert.equal(p.phase, 'review_waiting');
  assert.equal(p.status, 'running');
  assert.equal(p.loop_iteration, 2);
  assert.equal(stub.sentMessages.length, 1, 'main agent woken with new findings');
  assert.ok(stub.sentMessages[0]?.includes('review round 2: reviewer found defects again'));

  await settled({}, ctx);

  // Round 3 (settled): pass — done, notified, no further wake.
  p = currentPipeline();
  assert.equal(p.phase, 'done');
  assert.equal(p.status, 'done');
  assert.equal(p.verdict, 'pass');
  assert.equal(p.loop_iteration, 2);
  assert.equal(stub.sentMessages.length, 1);
  assert.ok(
    notifications.some((n) => n.title === 'Jovaltus review complete' && n.level === 'info'),
    'completion notification',
  );
  void verdictFile;
});

test('simplify: fix → pass loop parks in simplify_waiting and terminates', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  useVerdictPlan(tmp, ['fix', 'pass']);
  const round1 = await callTool(stub, 'simplify', {}, cwd);
  assert.equal(round1.details['verdict'], 'fix');
  let p = currentPipeline();
  assert.equal(p.phase, 'simplify_waiting');
  assert.equal(p.loop_iteration, 1);
  const settled = stub.handlers.get('agent_settled');
  assert.ok(settled !== undefined);
  const { ctx } = makeCtx(cwd);
  await settled({}, ctx);
  p = currentPipeline();
  assert.equal(p.phase, 'done');
  assert.equal(p.status, 'done');
  assert.equal(p.verdict, 'pass');
  assert.equal(p.loop_iteration, 1);
});

test('review: missing/invalid verdict.json fails deterministically', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  useVerdictPlan(tmp, ['invalid']);
  const result = await callTool(stub, 'review', {}, cwd);
  assert.equal(result.details['isError'], true);
  assert.ok((result.content[0]?.text ?? '').includes('verdict.json missing or invalid'));
  const p = currentPipeline();
  assert.equal(p.status, 'failed');
  assert.equal(p.phase, 'review', 'phase unchanged on verdict failure');
  assert.ok(p.error !== null && p.error.includes('verdict.json missing or invalid'));
});

test('agent_settled: no-op outside a running *waiting reviewer pipeline', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  const settled = stub.handlers.get('agent_settled');
  assert.ok(settled !== undefined);
  const { ctx } = makeCtx(cwd);

  // Idle: no pipeline at all.
  await settled({}, ctx);
  assert.equal(getPipeline(), null);
  assert.equal(stub.sentMessages.length, 0);

  // Finished pipeline.
  useVerdictPlan(tmp, ['pass']);
  await callTool(stub, 'review', {}, cwd);
  assert.equal(currentPipeline().status, 'done');
  await settled({}, ctx);
  assert.equal(stub.sentMessages.length, 0, 'no re-dispatch on a finished pipeline');

  // Running but non-waiting phase (plan tool).
  setAgentDir(path.join(tmp, 'agent'));
  const p = startPipeline('plan', '/repo/.plan/20260101/x', 'req', null);
  await settled({}, ctx);
  assert.equal(getPipeline()?.phase, 'prd', 'plan pipelines are not re-dispatched');
  assert.equal(stub.sentMessages.length, 0);
  setPhase(p, 'done');
  finishPipeline(p, true);
});

test('before_agent_start: injects status into every turn; nothing when idle', async (t) => {
  const { cwd, stub } = setupRun(t);
  const hook = stub.handlers.get('before_agent_start');
  assert.ok(hook !== undefined);
  const { ctx } = makeCtx(cwd);

  // Idle: no injection.
  const idle = await hook({ systemPrompt: 'base prompt' }, ctx);
  assert.equal(idle, undefined);

  // Running pipeline: status line appended.
  setAgentDir(path.join(cwd, '..', 'agent'));
  const p = startPipeline('plan', '/repo/.plan/20260101/feature', 'Build X', null);
  const injected = (await hook({ systemPrompt: 'base prompt' }, ctx)) as {
    systemPrompt?: string;
  };
  assert.ok(injected.systemPrompt !== undefined);
  assert.ok(injected.systemPrompt.startsWith('base prompt'));
  assert.ok(injected.systemPrompt.includes('[Jovaltus pipeline]'));
  assert.ok(injected.systemPrompt.includes('tool=plan phase=prd status=running'));
  assert.ok(injected.systemPrompt.includes('run_dir=/repo/.plan/20260101/feature'));

  // Plan complete: the summary names tasks.md.
  setPhase(p, 'done');
  finishPipeline(p, true);
  const done = (await hook({ systemPrompt: 'base' }, ctx)) as { systemPrompt?: string };
  assert.ok(done.systemPrompt !== undefined);
  assert.ok(done.systemPrompt.includes('plan complete: /repo/.plan/20260101/feature/tasks.md'));
});

test('model-based: random verdict plans reach done with exactly the fix loop semantics', async () => {
  // A reviewer run is a (possibly empty) sequence of fix rounds terminated
  // by one pass — plans with a fix after the pass are unreachable (the pass
  // finishes the pipeline and agent_settled becomes a no-op), so the
  // generator only produces reachable plans.
  const arbVerdicts = fc
    .array(fc.constant('fix'), { minLength: 0, maxLength: 5 })
    .map((fixes) => [...fixes, 'pass']);
  await fc.assert(
    fc.asyncProperty(arbVerdicts, async (verdicts) => {
      const tmp = makeTmpDir();
      try {
        const cwd = path.join(tmp, 'repo');
        mkdirSync(cwd, { recursive: true });
        setAgentDir(path.join(tmp, 'agent'));
        freshFakeEnv(tmp, { JOVALTUS_FAKE_OUTPUT: 'reviewed', JOVALTUS_FAKE_FINDINGS: 'defect' });
        useVerdictPlan(tmp, verdicts);
        const stub = captureApi();
        jovaltusFactory(stub.api);
        const { ctx } = makeCtx(cwd);
        const tool = requireTool(stub, 'review');
        const settled = stub.handlers.get('agent_settled');
        assert.ok(settled !== undefined);

        const round1 = (await tool.execute('id', {}, undefined, undefined, ctx)) as ToolCallResult;
        const fixes = verdicts.filter((v) => v === 'fix').length;
        const firstIsFix = verdicts[0] === 'fix';

        if (!firstIsFix) {
          assert.equal(round1.details['verdict'], undefined);
          const p = currentPipeline();
          assert.equal(p.phase, 'done');
          assert.equal(p.status, 'done');
          assert.equal(p.verdict, 'pass');
          assert.equal(p.loop_iteration, 0);
          await settled({}, ctx);
          assert.equal(stub.sentMessages.length, 0);
          return;
        }

        assert.equal(round1.details['verdict'], 'fix');
        let p = currentPipeline();
        assert.equal(p.phase, 'review_waiting');
        assert.equal(p.status, 'running');
        assert.equal(p.loop_iteration, 1);
        for (let i = 1; i < verdicts.length; i += 1) {
          await settled({}, ctx);
          p = currentPipeline();
          if (verdicts[i] === 'fix') {
            assert.equal(p.phase, 'review_waiting', `round ${String(i)} stays parked`);
            assert.equal(p.status, 'running');
          } else {
            assert.equal(p.phase, 'done', `round ${String(i)} finishes`);
            assert.equal(p.status, 'done');
            assert.equal(p.verdict, 'pass');
          }
        }
        assert.equal(p.loop_iteration, fixes, 'loop_iteration counts every fix round');
        assert.equal(stub.sentMessages.length, fixes - 1, 'only settled fix rounds wake the agent');
      } finally {
        clearFakeEnv();
        rmSync(tmp, { recursive: true, force: true });
      }
    }),
    { numRuns: 10 },
  );
});

// ---- list_sessions / resume_session / interruption ------------------------

test('factory registers the six pipeline tools', (t) => {
  const { stub } = setupRun(t);
  for (const name of ['plan', 'execute', 'simplify', 'review', 'list_sessions', 'resume_session']) {
    assert.ok(stub.tools.has(name), `registers ${name}`);
  }
});

test('list_sessions: reports every past session with its status, filterable', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  // A done plan.
  await callTool(stub, 'plan', { user_requirements: 'Feature one' }, cwd);
  // A parked (running) review.
  useVerdictPlan(tmp, ['fix']);
  await callTool(stub, 'review', {}, cwd);

  const result = await callTool(stub, 'list_sessions', {}, cwd);
  assert.ok(!result.details['isError']);
  const sessions = result.details['sessions'] as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 2, 'both sessions are listed');
  assert.equal(sessions[0]?.tool, 'review');
  assert.equal(sessions[0]?.status, 'running');
  assert.equal(sessions[1]?.tool, 'plan');
  assert.equal(sessions[1]?.status, 'done');

  const text = result.content[0]?.text ?? '';
  assert.ok(text.includes('| review | running |'), 'text shows the running review');
  assert.ok(text.includes('| plan | done |'), 'text shows the done plan');

  // Status filter narrows the list.
  const filtered = await callTool(stub, 'list_sessions', { status: 'done' }, cwd);
  assert.ok(!filtered.details['isError']);
  const filteredSessions = filtered.details['sessions'] as Array<Record<string, unknown>>;
  assert.equal(filteredSessions.length, 1);
  assert.equal(filteredSessions[0]?.tool, 'plan');

  // An unknown status filter reports an error.
  const none = await callTool(stub, 'list_sessions', { status: 'interrupted' }, cwd);
  assert.equal(none.details['isError'], true);
});

test('session_shutdown: a parked running pipeline becomes interrupted, not failed', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  useVerdictPlan(tmp, ['fix']);
  const round1 = await callTool(stub, 'review', {}, cwd);
  assert.equal(round1.details['verdict'], 'fix');
  const parked = currentPipeline();
  assert.equal(parked.status, 'running');

  const shutdown = stub.handlers.get('session_shutdown');
  assert.ok(shutdown !== undefined, 'factory registered session_shutdown');
  const { ctx } = makeCtx(cwd);
  await shutdown({}, ctx);

  const p = currentPipeline();
  assert.equal(p.status, 'interrupted');
  assert.equal(p.error, null, 'interruption is not an error');
  assert.equal(p.phase, 'review_waiting', 'the parking phase is preserved for resume');
  assert.ok(p.ended_at !== null);
});

test('resume_session: an interrupted review_waiting session falls back to the reviewer until pass', async (t) => {
  const { tmp, cwd, stub, logFile } = setupRun(t);
  useVerdictPlan(tmp, ['fix', 'pass']);
  const round1 = await callTool(stub, 'review', {}, cwd);
  assert.equal(round1.details['verdict'], 'fix');
  const parked = currentPipeline();
  assert.equal(parked.phase, 'review_waiting');

  // The session ends (e.g. app close) while parked → interrupted.
  const shutdown = stub.handlers.get('session_shutdown');
  assert.ok(shutdown !== undefined);
  const { ctx } = makeCtx(cwd);
  await shutdown({}, ctx);
  assert.equal(currentPipeline().status, 'interrupted');

  // Resume: the reviewer re-runs against the current diff; the next verdict
  // (pass) finishes the loop with the loop counter preserved.
  const result = await callTool(stub, 'resume_session', { session_id: parked.id }, cwd);
  assert.ok(!result.details['isError'], `resume succeeds: ${result.content[0]?.text}`);
  assert.ok((result.content[0]?.text ?? '').includes('resumed session'), 'reports the resume');
  const p = currentPipeline();
  assert.equal(p.status, 'done');
  assert.equal(p.phase, 'done');
  assert.equal(p.verdict, 'pass');
  assert.equal(p.loop_iteration, 1, 'loop counter survives the interrupt');

  // The resumed reviewer ran once (fix round 1 + resumed pass round).
  const dispatched = readFakeLog(logFile).map((e) => e.phase);
  assert.deepEqual(dispatched, ['review', 'review']);
});

test('resume_session: a failed plan session resumes from the interrupted phase with a resume note', async (t) => {
  const { cwd, stub, logFile } = setupRun(t);
  process.env.JOVALTUS_FAKE_FAIL_ON = 'research';
  const failed = await callTool(stub, 'plan', { user_requirements: 'Build resume' }, cwd);
  assert.equal(failed.details['isError'], true);
  const p = currentPipeline();
  assert.equal(p.status, 'failed');
  assert.equal(p.phase, 'research');

  // Resume dispatches only the remaining plan phases — not prd again — and
  // the resumed phase carries the resume note (artifact-aware continuation).
  delete process.env.JOVALTUS_FAKE_FAIL_ON;
  const result = await callTool(stub, 'resume_session', { session_id: p.id }, cwd);
  assert.ok(!result.details['isError'], `resume succeeds: ${result.content[0]?.text}`);
  const dispatched = readFakeLog(logFile).map((e) => e.phase);
  assert.deepEqual(dispatched, ['prd', 'research', 'research', 'acceptance', 'tasks']);
  const resumedResearch = readFakeLog(logFile).find(
    (e) => e.phase === 'research' && e.prompt.includes('Resumed run'),
  );
  assert.ok(resumedResearch !== undefined, 'the resumed phase prompt carries the resume note');

  const done = currentPipeline();
  assert.equal(done.status, 'done');
  assert.equal(done.phase, 'done');
});

test('resume_session: a failed execute session resumes and finishes', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  const planPath = path.join(tmp, 'plans', 'tasks.md');
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# Tasks\n', 'utf8');
  process.env.JOVALTUS_FAKE_FAIL_ON = 'execute';
  const failed = await callTool(stub, 'execute', { plan: planPath }, cwd);
  assert.equal(failed.details['isError'], true);
  const p = currentPipeline();
  assert.equal(p.status, 'failed');

  delete process.env.JOVALTUS_FAKE_FAIL_ON;
  const result = await callTool(stub, 'resume_session', { session_id: p.id }, cwd);
  assert.ok(!result.details['isError'], `resume succeeds: ${result.content[0]?.text}`);
  const done = currentPipeline();
  assert.equal(done.status, 'done');
  assert.equal(done.phase, 'done');
});

test('resume_session: accepts a run directory and errors on missing/running/done', async (t) => {
  const { tmp, cwd, stub } = setupRun(t);
  // Missing.
  const missing = await callTool(stub, 'resume_session', { session_id: 'ghost' }, cwd);
  assert.equal(missing.details['isError'], true);
  assert.ok((missing.content[0]?.text ?? '').includes('no Jovaltus session'));

  // Running: a parked review cannot be resumed while active.
  useVerdictPlan(tmp, ['fix', 'pass']);
  const round1 = await callTool(stub, 'review', {}, cwd);
  assert.equal(round1.details['verdict'], 'fix');
  const parked = currentPipeline();
  assert.equal(parked.status, 'running');
  const running = await callTool(stub, 'resume_session', { session_id: parked.id }, cwd);
  assert.equal(running.details['isError'], true);
  assert.ok((running.content[0]?.text ?? '').includes('already running'));

  // Done: finish the loop, then resume errors.
  const settled = stub.handlers.get('agent_settled');
  assert.ok(settled !== undefined);
  const { ctx } = makeCtx(cwd);
  await settled({}, ctx);
  assert.equal(currentPipeline().status, 'done');
  const doneResume = await callTool(stub, 'resume_session', { session_id: parked.id }, cwd);
  assert.equal(doneResume.details['isError'], true);
  assert.ok((doneResume.content[0]?.text ?? '').includes('already completed'));

  // A run directory works as the session handle too.
  process.env.JOVALTUS_FAKE_FAIL_ON = 'acceptance';
  const failed = await callTool(stub, 'plan', { user_requirements: 'Dir handle' }, cwd);
  assert.equal(failed.details['isError'], true);
  const failedSession = currentPipeline();
  assert.equal(failedSession.status, 'failed');
  delete process.env.JOVALTUS_FAKE_FAIL_ON;
  const byDir = await callTool(
    stub,
    'resume_session',
    { session_id: String(failedSession.run_dir) },
    cwd,
  );
  assert.ok(!byDir.details['isError'], 'resume by run_dir succeeds');
});

test('abort: an aborted phase dispatch interrupts the pipeline instead of failing it', async (t) => {
  const { cwd, stub } = setupRun(t);
  process.env.JOVALTUS_FAKE_SLOW_MS = '500';
  const tool = requireTool(stub, 'plan');
  const controller = new AbortController();
  const { ctx } = makeCtx(cwd, { signal: controller.signal });
  const promise = tool.execute(
    'call-1',
    { user_requirements: 'Abort me' },
    undefined,
    undefined,
    ctx,
  );
  const abortTimer = setTimeout(() => controller.abort(), 100);
  const result = (await promise) as ToolCallResult;
  clearTimeout(abortTimer);

  assert.equal(result.details['isError'], true);
  assert.ok((result.content[0]?.text ?? '').includes('interrupted'), 'reports interruption');
  const p = currentPipeline();
  assert.equal(p.status, 'interrupted');
  assert.equal(p.error, null, 'an abort is not an error');
  assert.ok(p.ended_at !== null);
});
