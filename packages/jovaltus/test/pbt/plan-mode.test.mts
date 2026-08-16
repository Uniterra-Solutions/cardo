import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import jovaltusFactory from '../../dist/index.js';
import {
  buildExecuteWidgetLines,
  JOVALTUS_EXECUTE_WIDGET_KEY,
  JOVALTUS_MODE_STATUS_KEY,
  PLAN_MODE_TOOLS,
  planExecuteWidgetAgentDone,
  planExecuteWidgetAgentStart,
  planExecuteWidgetDone,
  planExecuteWidgetInitial,
} from '../../dist/plan-mode.js';
import type { ExecutionPlan } from '../../dist/plan.js';
import {
  captureApi,
  clearFakeEnv,
  freshFakeEnv,
  handlerFor,
  makeCtx,
  makeTmpDir,
  setAgentDir,
} from '../helpers/stub-api.mts';

/** Run the factory against a fresh capture; returns the stub. */
function setupStub() {
  const stub = captureApi();
  jovaltusFactory(stub.api);
  return stub;
}

function planOf(batches: string[][]): ExecutionPlan {
  return {
    execution_mode: batches.length === 1 ? 'parallel' : 'batched',
    batches: batches.map((ids) => ids.map((id) => ({ id, task_prompt: `task ${id}` }))),
  };
}

// ---- mode toggle -----------------------------------------------------------

test('planmode command toggles plan mode: tools, status, persistence', () => {
  const stub = setupStub();
  const cmd = stub.commands.get('planmode');
  assert.ok(cmd !== undefined, 'planmode command registered');
  const handler = (cmd as { handler: (args: unknown, ctx: unknown) => void }).handler;
  const cwd = makeTmpDir();
  const first = makeCtx(cwd);
  handler({}, first.ctx);

  // Mode ON: plan-mode tools active, status set, entry persisted.
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(stub.activeTools.includes(tool), `mode ON exposes ${tool}`);
  }
  assert.equal(first.statuses.at(-1)?.key, JOVALTUS_MODE_STATUS_KEY);
  assert.equal(first.statuses.at(-1)?.text, 'plan mode');
  assert.deepEqual(stub.entries.at(-1), {
    type: 'custom',
    customType: 'jovaltus-mode',
    data: { mode: 'plan' },
  });

  // Mode OFF: plan-mode tools removed, status standard.
  const second = makeCtx(cwd);
  handler({}, second.ctx);
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(!stub.activeTools.includes(tool), `mode OFF hides ${tool}`);
  }
  assert.equal(second.statuses.at(-1)?.text, 'standard');
});

test('planmode shortcut registered for the TUI (shift+tab is app.thinking.cycle)', () => {
  const stub = setupStub();
  assert.ok(stub.shortcuts.includes('shift+p'), 'shift+P fallback registered');
});

// ---- tool gating -----------------------------------------------------------

test('tool_call gate blocks plan-mode tools while off, allows them while on', () => {
  const stub = setupStub();
  const gate = handlerFor(stub, 'tool_call');
  assert.ok(gate !== undefined, 'tool_call gate registered');

  const blocked = gate({ toolName: 'execute_plan', input: {} }, makeCtx(makeTmpDir()).ctx) as {
    block: boolean;
    reason: string;
  };
  assert.equal(blocked.block, true);
  assert.ok(blocked.reason.includes('plan mode is off'));

  const blockedPlan = gate({ toolName: 'plan', input: {} }, makeCtx(makeTmpDir()).ctx) as {
    block: boolean;
  };
  assert.equal(blockedPlan.block, true);

  // Non-plan-mode tools pass through untouched.
  assert.equal(gate({ toolName: 'edit', input: {} }, makeCtx(makeTmpDir()).ctx), undefined);
  assert.equal(gate({ toolName: 'review', input: {} }, makeCtx(makeTmpDir()).ctx), undefined);

  // Mode ON: plan-mode tools allowed.
  const cmd = stub.commands.get('planmode') as { handler: (args: unknown, ctx: unknown) => void };
  cmd.handler({}, makeCtx(makeTmpDir()).ctx);
  assert.equal(gate({ toolName: 'execute_plan', input: {} }, makeCtx(makeTmpDir()).ctx), undefined);
});

// ---- session start / system prompt ----------------------------------------

test('session_start restores the persisted mode and re-applies tools (legacy { enabled } entry)', () => {
  const stub = setupStub();
  const start = handlerFor(stub, 'session_start');
  assert.ok(start !== undefined, 'session_start handler registered');

  const cwd = makeTmpDir();
  // Legacy write format: `{ enabled: true }` restores plan mode via the
  // modeEntryRead fallback (D4 read-compat).
  start(
    {},
    makeCtx(cwd, {
      sessionEntries: [{ type: 'custom', customType: 'jovaltus-mode', data: { enabled: true } }],
    }).ctx,
  );
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(stub.activeTools.includes(tool), `restored mode exposes ${tool}`);
  }
});

test('session_start restores a { mode: "debug" } entry to debug mode', () => {
  const stub = setupStub();
  const start = handlerFor(stub, 'session_start');
  assert.ok(start !== undefined);
  const cwd = makeTmpDir();
  const ctx = makeCtx(cwd, {
    sessionEntries: [{ type: 'custom', customType: 'jovaltus-mode', data: { mode: 'debug' } }],
  });
  start({}, ctx.ctx);
  assert.equal(ctx.statuses.at(-1)?.text, 'debug mode');
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(!stub.activeTools.includes(tool), 'debug mode hides plan tools');
  }
});

test('session_start honors the --plan-mode flag', () => {
  const stub = setupStub();
  stub.flagValues.set('plan-mode', true);
  const start = handlerFor(stub, 'session_start');
  assert.ok(start !== undefined);
  start({}, makeCtx(makeTmpDir()).ctx);
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(stub.activeTools.includes(tool));
  }
});

test('before_agent_start injects the plan-mode note only while enabled', () => {
  const stub = setupStub();
  const hooks = stub.handlers.get('before_agent_start');
  assert.ok(hooks !== undefined && hooks.length >= 2, 'pipeline + plan-mode hooks registered');

  const invoke = (systemPrompt: string): Array<{ systemPrompt: string } | undefined> =>
    hooks.map(
      (hook) =>
        hook({ systemPrompt }, makeCtx(makeTmpDir()).ctx) as { systemPrompt: string } | undefined,
    );

  // OFF: no plan-mode note from any hook (no active pipeline either).
  for (const result of invoke('base')) {
    assert.ok(result === undefined || !result.systemPrompt.includes('[JOVALTUS PLAN MODE]'));
  }

  // ON: one hook appends the plan-mode note.
  const cmd = stub.commands.get('planmode') as {
    handler: (args: unknown, ctx: unknown) => Promise<void>;
  };
  cmd.handler({}, makeCtx(makeTmpDir()).ctx);
  const notes = invoke('base').filter(
    (result): result is { systemPrompt: string } =>
      result !== undefined && result.systemPrompt.includes('[JOVALTUS PLAN MODE]'),
  );
  assert.equal(notes.length, 1, 'exactly the plan-mode hook injects the note');
  assert.ok(notes[0]?.systemPrompt.startsWith('base'));
});

// ---- execute widget protocol ----------------------------------------------

test('execute widget: initial state is all-pending at step 0 with mode from the plan', () => {
  const state = planExecuteWidgetInitial(planOf([['a', 'b'], ['c']]));
  assert.equal(state.status, 'running');
  assert.equal(state.mode, 'batched');
  assert.equal(state.stepIndex, 0);
  assert.deepEqual(state.batches, [['a', 'b'], ['c']]);
  assert.deepEqual(
    [...state.agents.entries()],
    [
      ['a', 'pending'],
      ['b', 'pending'],
      ['c', 'pending'],
    ],
  );
});

test('execute widget: start/done transitions and terminal done state', () => {
  let state = planExecuteWidgetInitial(planOf([['a', 'b']]));
  state = planExecuteWidgetAgentStart(state, 'a');
  state = planExecuteWidgetAgentStart(state, 'b');
  assert.equal(state.agents.get('a'), 'running');
  assert.equal(state.agents.get('b'), 'running');

  state = planExecuteWidgetAgentDone(state, 'a', 0);
  assert.equal(state.agents.get('a'), 'done');
  assert.equal(state.stepIndex, 0);

  state = planExecuteWidgetAgentDone(state, 'b', 0);
  state = planExecuteWidgetDone(state);
  assert.equal(state.status, 'done');
  assert.equal(state.stepIndex, -1);
  assert.deepEqual([...state.agents.values()], ['done', 'done']);
});

test('execute widget lines are unambiguous and parseable (round-trip)', () => {
  let state = planExecuteWidgetInitial(planOf([['alpha', 'b2'], ['c']]));
  state = planExecuteWidgetAgentStart(state, 'alpha');
  const lines = buildExecuteWidgetLines(state);
  assert.deepEqual(lines, [
    'STATUS|running',
    'MODE|batched',
    'STEP|0',
    'BATCH|0|alpha,b2',
    'BATCH|1|c',
    'AGENT|alpha|running',
    'AGENT|b2|pending',
    'AGENT|c|pending',
  ]);

  // Property: for every plan shape the lines split back into their fields
  // without collisions (ids/modes/states never contain '|').
  fc.assert(
    fc.property(
      fc.array(
        fc.array(
          fc
            .array(fc.constantFrom(...'abz09_-'), { minLength: 1, maxLength: 8 })
            .map((chars) => chars.join('')),
          { minLength: 1, maxLength: 3 },
        ),
        { minLength: 1, maxLength: 3 },
      ),
      (batches: string[][]) => {
        const generated = planOf(batches.map((ids) => [...new Set(ids)]));
        const state = planExecuteWidgetInitial(generated);
        const parsed = buildExecuteWidgetLines(state).map((line) => line.split('|'));
        for (const fields of parsed) {
          assert.ok(fields.length >= 2, 'every line has a tag + value');
          for (const field of fields) {
            assert.ok(!field.includes('|'), 'no embedded separators');
          }
        }
        assert.equal(parsed[0]?.[0], 'STATUS');
        assert.equal(parsed[0]?.[1], 'running');
      },
    ),
  );
});

// ---- integrated: execute_plan streams the widget --------------------------

test('execute_plan streams the execute widget through the extension UI', async (t) => {
  const stub = setupStub();
  const tmp = makeTmpDir();
  t.after(() => {
    clearFakeEnv();
  });
  const cwd = `${tmp}/repo`;
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd, { recursive: true });
  setAgentDir(`${tmp}/agent`);
  freshFakeEnv(tmp, { JOVALTUS_FAKE_OUTPUT: 'phase executed' });
  // Complete a plan session first so execute_plan has a source plan.
  const planTool = stub.tools.get('plan');
  assert.ok(planTool !== undefined);
  const planResult = await planTool.execute(
    'call-1',
    { user_requirements: 'Widget flow' },
    undefined,
    undefined,
    makeCtx(cwd).ctx,
  );
  const runDir = String((planResult as { details: Record<string, unknown> }).details['run_dir']);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    `${runDir}/execution-plan.json`,
    JSON.stringify({
      execution_mode: 'batched',
      batches: [
        [
          { id: 'a', task_prompt: 'task a' },
          { id: 'b', task_prompt: 'task b' },
        ],
        [{ id: 'c', task_prompt: 'task c' }],
      ],
    }),
    'utf8',
  );
  const settled = handlerFor(stub, 'agent_settled');
  assert.ok(settled !== undefined);
  await settled({}, makeCtx(cwd).ctx);

  const uiCtx = makeCtx(cwd);
  const executePlan = stub.tools.get('execute_plan');
  assert.ok(executePlan !== undefined);
  const result = await executePlan.execute(
    'call-2',
    { plan_id: runDir },
    undefined,
    undefined,
    uiCtx.ctx,
  );
  assert.ok(!(result as { details: Record<string, unknown> }).details['isError']);

  // The widget was pushed at least at start and finish, with the final push
  // carrying the terminal done state.
  const pushes = uiCtx.widgets.filter((w) => w.key === JOVALTUS_EXECUTE_WIDGET_KEY);
  assert.ok(pushes.length >= 3, `widget pushed repeatedly (got ${String(pushes.length)})`);
  const finalLines = pushes.at(-1)?.lines;
  assert.ok(finalLines !== undefined);
  assert.deepEqual(finalLines, [
    'STATUS|done',
    'MODE|batched',
    'STEP|-1',
    'BATCH|0|a,b',
    'BATCH|1|c',
    'AGENT|a|done',
    'AGENT|b|done',
    'AGENT|c|done',
  ]);
});
