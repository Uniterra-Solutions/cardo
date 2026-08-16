/**
 * Failing PBT spec for the cardo mode registry (`standard | plan | debug`).
 *
 * RED PHASE: these properties encode the design-doc §5 invariants for the
 * pure mode core (`src/mode.ts`, compiled to `dist/mode.js`). The module
 * does not exist yet — importing it fails, which is the intended red state.
 *
 * Surface locked here (all named exports from `dist/mode.js`):
 * `CardoMode`, `ToolSetState`, `MODE_CYCLE`, `nextMode`, `modeToStatusText`,
 * `statusTextToMode`, `modeEntryWrite`, `modeEntryRead`, `togglePlanMode`,
 * `toggleDebugMode`, `restoreMode`, `DEBUG_MODE_NOTE`, `debugPromptAppend`,
 * `applyModeTools`.
 *
 * NOTE: `restoreMode` takes both start flags `{ plan, debug }` — the design
 * doc's §5.5 table shows a single-flag shorthand (`restoreMode(debugFlag,
 * persisted)`), which is the `{ plan: false, debug }` special case here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import {
  DEBUG_MODE_NOTE,
  MODE_CYCLE,
  applyModeTools,
  debugPromptAppend,
  modeEntryRead,
  modeEntryWrite,
  modeToStatusText,
  nextMode,
  restoreMode,
  statusTextToMode,
  toggleDebugMode,
  togglePlanMode,
  type CardoMode,
  type ToolSetState,
} from '../../dist/mode.js';

const MODES: readonly CardoMode[] = ['standard', 'plan', 'debug'];
const modeArb = fc.constantFrom(...MODES);
/** The plan-mode tool names (kept in sync with `PLAN_MODE_TOOLS`). */
const PLAN_TOOLS: readonly string[] = ['plan', 'execute_plan'];
/** Base tool set never contains plan tools (design-doc precondition). */
const BASE_TOOLS: readonly string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

test('cycle: nextMode³(m) === m and the cycle visits all three modes', () => {
  assert.deepEqual(MODE_CYCLE, ['standard', 'plan', 'debug']);
  fc.assert(
    fc.property(modeArb, (m) => {
      const a = nextMode(m);
      const b = nextMode(a);
      const c = nextMode(b);
      assert.equal(c, m, 'nextMode cubed is the identity');
      assert.equal(new Set([m, a, b]).size, 3, 'the cycle visits exactly three distinct modes');
    }),
  );
});

test('status text: bijection between mode and status text, total inverse', () => {
  assert.equal(modeToStatusText('standard'), 'standard');
  assert.equal(modeToStatusText('plan'), 'plan mode');
  assert.equal(modeToStatusText('debug'), 'debug mode');
  assert.equal(statusTextToMode('standard'), 'standard');
  assert.equal(statusTextToMode('plan mode'), 'plan');
  assert.equal(statusTextToMode('debug mode'), 'debug');
  // Injectivity over CardoMode.
  assert.equal(new Set(MODES.map(modeToStatusText)).size, 3, 'modeToStatusText is injective');
  // Round-trip.
  fc.assert(
    fc.property(modeArb, (m) => {
      assert.equal(statusTextToMode(modeToStatusText(m)), m, 'status text round-trips');
    }),
  );
  // Totality: arbitrary strings (incl. undefined/garbage) map to a valid mode.
  fc.assert(
    fc.property(fc.oneof(fc.constant(undefined), fc.string()), (text) => {
      assert.ok(MODES.includes(statusTextToMode(text)), 'inverse is total and yields a valid mode');
    }),
  );
});

test('persistence: write/read round-trip plus the legacy { enabled } fallback', () => {
  assert.deepEqual(modeEntryWrite('plan'), { mode: 'plan' });
  fc.assert(
    fc.property(modeArb, (m) => {
      assert.equal(modeEntryRead(modeEntryWrite(m)), m, 'write/read round-trips');
    }),
  );
  // Legacy and garbage shapes — the read is total and never throws.
  const cases: Array<[unknown, CardoMode]> = [
    [{ enabled: true }, 'plan'],
    [{ enabled: false }, 'standard'],
    [{}, 'standard'],
    [null, 'standard'],
    [undefined, 'standard'],
    ['garbage', 'standard'],
    [{ mode: 'bogus' }, 'standard'],
    [42, 'standard'],
  ];
  for (const [data, expected] of cases) {
    assert.equal(modeEntryRead(data), expected, `modeEntryRead(${JSON.stringify(data)})`);
  }
});

test('toggle: plan and debug toggles follow the D2 transition table', () => {
  const planTable: Array<[CardoMode, CardoMode]> = [
    ['plan', 'standard'],
    ['standard', 'plan'],
    ['debug', 'plan'],
  ];
  for (const [from, to] of planTable) {
    assert.equal(togglePlanMode(from), to, `togglePlanMode(${from})`);
  }
  const debugTable: Array<[CardoMode, CardoMode]> = [
    ['debug', 'standard'],
    ['standard', 'debug'],
    ['plan', 'debug'],
  ];
  for (const [from, to] of debugTable) {
    assert.equal(toggleDebugMode(from), to, `toggleDebugMode(${from})`);
  }
  // Own-mode double-toggle returns to standard; outputs are always valid.
  assert.equal(togglePlanMode(togglePlanMode('standard')), 'standard');
  assert.equal(toggleDebugMode(toggleDebugMode('standard')), 'standard');
  fc.assert(
    fc.property(modeArb, (m) => {
      assert.ok(MODES.includes(togglePlanMode(m)), 'plan toggle yields a valid mode');
      assert.ok(MODES.includes(toggleDebugMode(m)), 'debug toggle yields a valid mode');
    }),
  );
});

test('restore: persisted mode wins over flags; flags decide only with no entry', () => {
  // Design §5.5 cases (two-flag form): persisted always wins.
  assert.equal(restoreMode({ plan: false, debug: true }, 'standard'), 'standard');
  assert.equal(restoreMode({ plan: false, debug: false }, 'debug'), 'debug');
  // No persisted mode → flags decide (plan flag wins over debug flag).
  assert.equal(restoreMode({ plan: false, debug: true }, undefined), 'debug');
  assert.equal(restoreMode({ plan: false, debug: false }, undefined), 'standard');
  assert.equal(restoreMode({ plan: true, debug: true }, undefined), 'plan');
  fc.assert(
    fc.property(
      fc.record({ plan: fc.boolean(), debug: fc.boolean() }),
      fc.oneof(modeArb, fc.constant(undefined)),
      (flags, persisted) => {
        const expected = persisted ?? (flags.plan ? 'plan' : flags.debug ? 'debug' : 'standard');
        assert.equal(restoreMode(flags, persisted), expected);
      },
    ),
  );
});

test('tools: active set never grows beyond base + plan tools; plan tools iff plan mode', () => {
  fc.assert(
    fc.property(fc.array(modeArb, { minLength: 1, maxLength: 24 }), (sequence) => {
      let state: ToolSetState = { active: [...BASE_TOOLS], baseBeforePlan: undefined };
      for (const mode of sequence) {
        state = applyModeTools(state, mode, PLAN_TOOLS);
        const active = [...state.active];
        assert.equal(
          PLAN_TOOLS.some((t) => active.includes(t)),
          mode === 'plan',
          'plan tools are active iff the mode is plan',
        );
        for (const tool of active) {
          assert.ok(
            BASE_TOOLS.includes(tool) || PLAN_TOOLS.includes(tool),
            'active never grows beyond base + plan tools',
          );
        }
      }
      // Repeatability: the final active set depends only on the final mode.
      const finalMode = sequence[sequence.length - 1]!;
      const sorted = (xs: readonly string[]): string => [...xs].sort().join(',');
      const expected =
        finalMode === 'plan'
          ? sorted([...BASE_TOOLS, ...PLAN_TOOLS])
          : sorted(BASE_TOOLS.filter((t) => !PLAN_TOOLS.includes(t)));
      assert.equal(sorted(state.active), expected, 'final active set is path-independent');
    }),
  );
  // Debug never adds tools: entering debug from plan yields base \ planTools.
  let state: ToolSetState = { active: [...BASE_TOOLS], baseBeforePlan: undefined };
  state = applyModeTools(state, 'plan', PLAN_TOOLS);
  state = applyModeTools(state, 'debug', PLAN_TOOLS);
  assert.deepEqual(
    state.active,
    BASE_TOOLS.filter((t) => !PLAN_TOOLS.includes(t)),
  );
});

test('prompt: the debug note is English ASCII, self-contained, appended exactly once', () => {
  const note = DEBUG_MODE_NOTE;
  assert.ok(note.startsWith('[DEBUG MODE]'), 'note is self-contained');
  // All-ASCII English, no emoji.
  assert.match(note, /^[\x20-\x7E\n\r]*$/, 'note is printable ASCII');
  // The three workflow steps appear in order.
  assert.match(
    note,
    /1\. Read and search the relevant business logic under investigation\.[\s\S]*2\. Define that business logic as invariants and reproduce the bug via property-based testing\.[\s\S]*3\. Fix the bug, then add or complete unit tests as regression tests\./,
    'the three steps appear in order',
  );
  // No reference to external skill files or documents.
  for (const banned of ['agentic-debugging', 'SKILL.md', '.md', '~/']) {
    assert.ok(!note.includes(banned), `note does not reference ${banned}`);
  }
  fc.assert(
    fc.property(fc.string(), (base) => {
      fc.pre(!base.includes('[DEBUG MODE]'));
      const appended = debugPromptAppend(base);
      assert.equal(appended, `${base}\n\n${note}`, 'append is deterministic and exact');
      assert.ok(appended.startsWith(base), 'base prompt preserved as prefix');
      assert.equal(appended.match(/\[DEBUG MODE\]/g)?.length, 1, 'note appears exactly once');
    }),
  );
});
