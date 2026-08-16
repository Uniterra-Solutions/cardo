/**
 * PBT spec for the debug-mode session state fold (`foldDebugMode`).
 *
 * Properties: no events → inactive; the LAST `debug/mode` wins; non-mode
 * events never change the fold; fold over a prefix is consistent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session';
import { foldDebugMode } from '../../dist/debug-state.js';

type AnyEvent = SessionEvent;

const NON_MODE_TYPES: readonly SessionEventType[] = [
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/message',
  'todo/write',
];

function modeEvent(seq: number, active: boolean): AnyEvent {
  return { type: 'debug/mode', seq, time: seq, data: { active } };
}

function otherEvent(seq: number, type: SessionEventType): AnyEvent {
  return { type, seq, time: seq, data: {} } as AnyEvent;
}

const activeArb = fc.boolean();

test('empty log is inactive', () => {
  assert.equal(foldDebugMode([]), false);
});

test('a single mode event reports its value', () => {
  fc.assert(
    fc.property(activeArb, (active) => {
      assert.equal(foldDebugMode([modeEvent(1, active)]), active);
    }),
  );
});

test('last mode event wins over earlier ones', () => {
  fc.assert(
    fc.property(fc.array(activeArb, { minLength: 2, maxLength: 12 }), (values) => {
      const events = values.map((active, i) => modeEvent(i + 1, active));
      assert.equal(foldDebugMode(events), values[values.length - 1]);
    }),
  );
});

test('non-mode events never change the fold', () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ active: activeArb }), { minLength: 0, maxLength: 10 }),
      fc.array(fc.constantFrom(...NON_MODE_TYPES), {
        minLength: 0,
        maxLength: 10,
      }),
      (modes, others) => {
        const events: AnyEvent[] = [];
        let seq = 0;
        let expected = false;
        for (let i = 0; i < Math.max(modes.length, others.length); i += 1) {
          if (i < modes.length) {
            const mode = modes[i]!;
            seq += 1;
            events.push(modeEvent(seq, mode.active));
            expected = mode.active;
          }
          if (i < others.length) {
            seq += 1;
            events.push(otherEvent(seq, others[i]!));
          }
        }
        assert.equal(foldDebugMode(events), expected, 'only debug/mode events matter');
      },
    ),
  );
});

test('end-prefix fold matches the corresponding tail decision', () => {
  fc.assert(
    fc.property(
      fc.array(activeArb, { minLength: 2, maxLength: 12 }),
      fc.integer({ min: 0, max: 12 }),
      (values, end) => {
        const events = values.map((active, i) => modeEvent(i + 1, active));
        const prefix = events.slice(0, Math.min(end, values.length));
        const expected = prefix.length === 0 ? false : values[Math.min(end, values.length) - 1]!;
        assert.equal(foldDebugMode(events, end), expected);
      },
    ),
  );
});
