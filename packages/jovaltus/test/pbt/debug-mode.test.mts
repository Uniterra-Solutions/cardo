/**
 * Failing PBT spec for the debug-mode extension wiring.
 *
 * RED PHASE: these tests drive `jovaltusFactory` (compiled `dist/index.js`)
 * and assert the extension-level invariants from design-doc §6.2 — the
 * `/debugmode` command, `debug-mode` flag, status/persistence/notify
 * contract, exclusivity with plan mode, tool-set transitions, restore
 * precedence, and `before_agent_start` prompt gating. They fail against the
 * current code: `dist/mode.js` is missing and the wiring does not yet
 * register debug mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import jovaltusFactory from '../../dist/index.js';
import { JOVALTUS_MODE_STATUS_KEY, PLAN_MODE_TOOLS } from '../../dist/plan-mode.js';
import {
  DEBUG_MODE_NOTE,
  modeEntryRead,
  modeEntryWrite,
  modeToStatusText,
  statusTextToMode,
  type CardoMode,
} from '../../dist/mode.js';
import {
  captureApi,
  handlerFor,
  makeCtx,
  makeTmpDir,
  setAgentDir,
  type StubApi,
} from '../helpers/stub-api.mts';

/** Run the factory against a fresh capture; returns the stub. */
function setupStub(): StubApi {
  const stub = captureApi();
  jovaltusFactory(stub.api);
  return stub;
}

type DebugCommand = { handler: (args: unknown, ctx: unknown) => void };

/** Invoke every before_agent_start hook with a base prompt; return appends. */
function appendedPrompts(stub: StubApi, cwd: string): string[] {
  const hooks = stub.handlers.get('before_agent_start') ?? [];
  const ctx = makeCtx(cwd);
  return hooks
    .map((hook) => hook({ systemPrompt: 'base' }, ctx.ctx))
    .filter(
      (result): result is { systemPrompt: string } =>
        result !== undefined &&
        typeof (result as { systemPrompt: string }).systemPrompt === 'string',
    )
    .map((result) => (result as { systemPrompt: string }).systemPrompt);
}

// ---- deterministic surface -------------------------------------------------

test('debugmode command toggles debug mode: status, persistence, notify, no tools', () => {
  const stub = setupStub();
  const cmd = stub.commands.get('debugmode');
  assert.ok(cmd !== undefined, 'debugmode command registered');
  const handler = (cmd as DebugCommand).handler;
  const cwd = makeTmpDir();

  const first = makeCtx(cwd);
  handler({}, first.ctx);
  // Status reflects debug mode under the shared jovaltus-mode key.
  assert.equal(first.statuses.at(-1)?.key, JOVALTUS_MODE_STATUS_KEY);
  assert.equal(first.statuses.at(-1)?.text, 'debug mode');
  // Persistence uses the shared entry type with the { mode } payload.
  assert.deepEqual(stub.entries.at(-1), {
    type: 'custom',
    customType: 'jovaltus-mode',
    data: { mode: 'debug' },
  });
  // Notify with the exact debug-on message.
  assert.deepEqual(first.notifications.at(-1), {
    title: 'Debug mode on: the agent follows the evidence-driven debug workflow',
    level: 'info',
  });
  // Debug adds no tools and keeps plan tools hidden.
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(!stub.activeTools.includes(tool), `plan tool ${tool} stays hidden in debug mode`);
  }

  const second = makeCtx(cwd);
  handler({}, second.ctx);
  assert.equal(second.statuses.at(-1)?.text, 'standard');
  assert.deepEqual(second.notifications.at(-1), {
    title: 'Debug mode off: the agent follows the standard workflow',
    level: 'info',
  });
});

test('debug-mode flag registered with default false; no extra tools or shortcuts', () => {
  const stub = setupStub();
  const flag = stub.flags.get('debug-mode');
  assert.ok(flag !== undefined, 'debug-mode flag registered');
  assert.equal(flag.type, 'boolean');
  assert.equal(flag.default, false);
  assert.equal(stub.tools.size, 6, 'debug adds no tools (six pipeline tools)');
  assert.deepEqual(stub.shortcuts, ['shift+p'], 'no new shortcut registered');
});

test('switching plan -> debug via /debugmode deactivates plan mode', () => {
  const stub = setupStub();
  const planmode = stub.commands.get('planmode') as DebugCommand;
  const debugmode = stub.commands.get('debugmode') as DebugCommand;
  const cwd = makeTmpDir();

  planmode.handler({}, makeCtx(cwd).ctx);
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(stub.activeTools.includes(tool), 'plan mode exposes plan tools');
  }

  const debugCtx = makeCtx(cwd);
  debugmode.handler({}, debugCtx.ctx);
  assert.equal(debugCtx.statuses.at(-1)?.text, 'debug mode');
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(!stub.activeTools.includes(tool), `plan tool ${tool} removed when entering debug`);
  }
  assert.deepEqual(debugCtx.notifications.at(-1), {
    title: 'Debug mode on: plan mode off — the agent follows the evidence-driven debug workflow',
    level: 'info',
  });
  assert.deepEqual(stub.entries.at(-1), {
    type: 'custom',
    customType: 'jovaltus-mode',
    data: { mode: 'debug' },
  });
});

test('switching debug -> plan via /planmode re-activates plan tools', () => {
  const stub = setupStub();
  const planmode = stub.commands.get('planmode') as DebugCommand;
  const debugmode = stub.commands.get('debugmode') as DebugCommand;
  const cwd = makeTmpDir();

  debugmode.handler({}, makeCtx(cwd).ctx);
  const planCtx = makeCtx(cwd);
  planmode.handler({}, planCtx.ctx);
  assert.equal(planCtx.statuses.at(-1)?.text, 'plan mode');
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(stub.activeTools.includes(tool), `plan tool ${tool} restored`);
  }
  assert.deepEqual(planCtx.notifications.at(-1), {
    title: 'Plan mode on: debug mode off — plan and execute_plan are available',
    level: 'info',
  });
});

test('tool_call gate: blocks plan tools unless mode is plan; debug is not gated', () => {
  const stub = setupStub();
  const gate = handlerFor(stub, 'tool_call');
  assert.ok(gate !== undefined, 'tool_call gate registered');

  // standard: blocked.
  const blocked = gate({ toolName: 'plan', input: {} }, makeCtx(makeTmpDir()).ctx) as {
    block: boolean;
  };
  assert.equal(blocked.block, true);

  // debug: still blocked (debug is not plan; FR-12 leaves the gate untouched).
  const debugmode = stub.commands.get('debugmode') as DebugCommand;
  debugmode.handler({}, makeCtx(makeTmpDir()).ctx);
  assert.equal(
    (gate({ toolName: 'execute_plan', input: {} }, makeCtx(makeTmpDir()).ctx) as { block: boolean })
      .block,
    true,
  );

  // plan: allowed.
  const planmode = stub.commands.get('planmode') as DebugCommand;
  planmode.handler({}, makeCtx(makeTmpDir()).ctx);
  assert.equal(gate({ toolName: 'execute_plan', input: {} }, makeCtx(makeTmpDir()).ctx), undefined);
  // Non-plan-mode tools always pass.
  assert.equal(gate({ toolName: 'edit', input: {} }, makeCtx(makeTmpDir()).ctx), undefined);
});

test('session_start restores a { mode: "debug" } entry to debug mode', () => {
  const stub = setupStub();
  const start = handlerFor(stub, 'session_start');
  assert.ok(start !== undefined, 'session_start handler registered');
  const cwd = makeTmpDir();
  const ctx = makeCtx(cwd, {
    sessionEntries: [{ type: 'custom', customType: 'jovaltus-mode', data: { mode: 'debug' } }],
  });
  start({}, ctx.ctx);
  assert.equal(ctx.statuses.at(-1)?.key, JOVALTUS_MODE_STATUS_KEY);
  assert.equal(ctx.statuses.at(-1)?.text, 'debug mode');
  for (const tool of PLAN_MODE_TOOLS) {
    assert.ok(!stub.activeTools.includes(tool), 'debug restore keeps plan tools hidden');
  }
});

test('before_agent_start appends the debug note iff debug mode is active', () => {
  const stub = setupStub();
  setAgentDir(makeTmpDir());
  const cwd = makeTmpDir();
  const debugmode = stub.commands.get('debugmode') as DebugCommand;

  // OFF: no debug note from any hook.
  const offPrompts = appendedPrompts(stub, cwd);
  assert.equal(offPrompts.filter((p) => p.includes('[DEBUG MODE]')).length, 0);

  // ON: exactly one hook appends the note; base preserved; no plan note.
  debugmode.handler({}, makeCtx(cwd).ctx);
  const onPrompts = appendedPrompts(stub, cwd);
  const debugNotes = onPrompts.filter((p) => p.includes('[DEBUG MODE]'));
  assert.equal(debugNotes.length, 1, 'exactly the debug hook injects the note');
  assert.ok(debugNotes[0]?.startsWith('base'), 'base prompt preserved as prefix');
  assert.equal(debugNotes[0], `base\n\n${DEBUG_MODE_NOTE}`, 'exact appended text');
  assert.equal(onPrompts.filter((p) => p.includes('[JOVALTUS PLAN MODE]')).length, 0);
});

// ---- property: random op sequences keep every cross-cutting invariant ------

/** Expected notify text for a toggle transition (design §3.2, asserted). */
function expectedNotify(prev: CardoMode, next: CardoMode): string {
  if (next === 'debug') {
    return prev === 'plan'
      ? 'Debug mode on: plan mode off — the agent follows the evidence-driven debug workflow'
      : 'Debug mode on: the agent follows the evidence-driven debug workflow';
  }
  if (next === 'standard') {
    return prev === 'debug'
      ? 'Debug mode off: the agent follows the standard workflow'
      : 'Plan mode off: plan and execute_plan are hidden';
  }
  return prev === 'debug'
    ? 'Plan mode on: debug mode off — plan and execute_plan are available'
    : 'Plan mode on: plan and execute_plan are available';
}

test('property: random op sequences keep exclusivity, persistence, tools, prompt gating', () => {
  const opArb = fc.oneof(
    fc.constantFrom('planmode' as const, 'debugmode' as const),
    fc.record({
      kind: fc.constant('session_start' as const),
      planFlag: fc.boolean(),
      debugFlag: fc.boolean(),
      persisted: fc.oneof(
        fc.constant(undefined),
        fc.constant({ enabled: true }),
        fc.constant({ enabled: false }),
        fc.record({
          mode: fc.constantFrom('standard' as const, 'plan' as const, 'debug' as const),
        }),
        fc.constant({ mode: 'bogus' }),
        fc.constant('garbage'),
      ),
    }),
  );
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 10 }), (ops) => {
      const stub = setupStub();
      setAgentDir(makeTmpDir());
      const cwd = makeTmpDir();
      const statuses: Array<{ key: string; text: string | undefined }> = [];
      let prevMode: CardoMode = 'standard';

      const currentMode = (): CardoMode => {
        const last = [...statuses].reverse().find((s) => s.key === JOVALTUS_MODE_STATUS_KEY);
        return statusTextToMode(last?.text);
      };

      for (const op of ops) {
        const ctx = makeCtx(cwd);
        if (op === 'planmode' || op === 'debugmode') {
          const cmd = stub.commands.get(op);
          assert.ok(cmd !== undefined, `${op} command registered`);
          const entriesBefore = stub.entries.length;
          (cmd as DebugCommand).handler({}, ctx.ctx);
          statuses.push(...ctx.statuses);
          const mode = currentMode();
          // Exactly one status push and one notify per toggle.
          assert.equal(ctx.statuses.filter((s) => s.key === JOVALTUS_MODE_STATUS_KEY).length, 1);
          assert.equal(ctx.notifications.length, 1, 'one notify per toggle');
          assert.equal(ctx.notifications[0]?.level, 'info');
          assert.equal(ctx.notifications[0]?.title, expectedNotify(prevMode, mode));
          // Exactly one entry written, in the shared format (last write wins).
          assert.equal(stub.entries.length, entriesBefore + 1);
          assert.deepEqual(stub.entries.at(-1), {
            type: 'custom',
            customType: 'jovaltus-mode',
            data: modeEntryWrite(mode),
          });
          prevMode = mode;
        } else {
          // session_start: restore precedence entry > plan flag > debug flag > standard.
          stub.flagValues.set('plan-mode', op.planFlag);
          stub.flagValues.set('debug-mode', op.debugFlag);
          const entriesBefore = stub.entries.length;
          const start = handlerFor(stub, 'session_start');
          assert.ok(start !== undefined, 'session_start handler registered');
          const startCtx = makeCtx(cwd, {
            sessionEntries:
              op.persisted === undefined
                ? []
                : [{ type: 'custom', customType: 'jovaltus-mode', data: op.persisted }],
          });
          start({}, startCtx.ctx);
          statuses.push(...startCtx.statuses);
          const expected =
            op.persisted === undefined
              ? op.planFlag
                ? 'plan'
                : op.debugFlag
                  ? 'debug'
                  : 'standard'
              : modeEntryRead(op.persisted);
          assert.equal(currentMode(), expected, 'restore precedence holds');
          assert.equal(stub.entries.length, entriesBefore, 'session_start writes no entry');
          prevMode = currentMode();
        }

        // Cross-cutting invariants after every op.
        const mode = currentMode();
        assert.equal(
          PLAN_MODE_TOOLS.some((t) => stub.activeTools.includes(t)),
          mode === 'plan',
          'plan tools are active iff the mode is plan',
        );
        const lastStatus = [...statuses].reverse().find((s) => s.key === JOVALTUS_MODE_STATUS_KEY);
        assert.equal(lastStatus?.text, modeToStatusText(mode), 'status text matches the mode');
        // Prompt gating: debug note iff debug, plan note iff plan, never both.
        const prompts = appendedPrompts(stub, cwd);
        assert.equal(
          prompts.filter((p) => p.includes('[DEBUG MODE]')).length,
          mode === 'debug' ? 1 : 0,
          'debug note gated on debug mode',
        );
        assert.equal(
          prompts.filter((p) => p.includes('[JOVALTUS PLAN MODE]')).length,
          mode === 'plan' ? 1 : 0,
          'plan note gated on plan mode',
        );
      }
    }),
  );
});
