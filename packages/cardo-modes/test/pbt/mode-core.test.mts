/**
 * PBT spec for the cardo mode core (`standard | plan | debug`).
 *
 * These properties encode the mode-registry invariants: the cycle visits
 * exactly three modes, toggles are total, restore precedence is
 * deterministic, and status text round-trips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import {
  DEBUG_MODE_NOTE,
  MODE_CYCLE,
  modeToStatusText,
  nextMode,
  restoreMode,
  statusTextToMode,
  toggleDebugMode,
  togglePlanMode,
  type CardoMode,
} from '../../dist/mode-core.js';

const MODES: readonly CardoMode[] = ['standard', 'plan', 'debug'];
const modeArb = fc.constantFrom(...MODES);

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
  fc.assert(
    fc.property(modeArb, (m) => {
      assert.equal(statusTextToMode(modeToStatusText(m)), m, 'status text round-trips');
    }),
  );
  fc.assert(
    fc.property(fc.string(), (s) => {
      assert.ok(['standard', 'plan', 'debug'].includes(statusTextToMode(s)), 'total inverse never throws');
    }),
  );
});

test('togglePlanMode: plan ↔ standard, debug → plan', () => {
  assert.equal(togglePlanMode('standard'), 'plan');
  assert.equal(togglePlanMode('plan'), 'standard');
  assert.equal(togglePlanMode('debug'), 'plan');
  fc.assert(
    fc.property(modeArb, (m) => {
      assert.equal(togglePlanMode(m), m === 'plan' ? 'standard' : 'plan', 'plan toggle is total');
    }),
  );
});

test('toggleDebugMode: debug ↔ standard, plan → debug', () => {
  assert.equal(toggleDebugMode('standard'), 'debug');
  assert.equal(toggleDebugMode('debug'), 'standard');
  assert.equal(toggleDebugMode('plan'), 'debug');
  fc.assert(
    fc.property(modeArb, (m) => {
      assert.equal(toggleDebugMode(m), m === 'debug' ? 'standard' : 'debug', 'debug toggle is total');
    }),
  );
});

test('restoreMode: persisted wins, then plan flag, then debug flag, then standard', () => {
  assert.equal(restoreMode({ plan: false, debug: false }, undefined), 'standard');
  assert.equal(restoreMode({ plan: false, debug: true }, undefined), 'debug');
  assert.equal(restoreMode({ plan: true, debug: false }, undefined), 'plan');
  assert.equal(restoreMode({ plan: true, debug: true }, undefined), 'plan', 'plan beats debug');
  fc.assert(
    fc.property(modeArb, fc.boolean(), fc.boolean(), (persisted, plan, debug) => {
      assert.equal(restoreMode({ plan, debug }, persisted), persisted, 'persisted mode always wins');
    }),
  );
});

test('DEBUG_MODE_NOTE: contains the three ordered workflow steps', () => {
  const note = DEBUG_MODE_NOTE;
  assert.ok(note.includes('1. Read and search the relevant business logic under investigation.'));
  assert.ok(note.includes('2. Define that business logic as invariants and reproduce the bug via property-based testing.'));
  assert.ok(note.includes('3. Fix the bug, then add or complete unit tests as regression tests.'));
  assert.ok(note.startsWith('[DEBUG MODE]'));
  assert.ok(!/[\u4e00-\u9fff]/.test(note), 'debug note stays ASCII (no CJK)');
});
