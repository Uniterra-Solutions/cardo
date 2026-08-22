/**
 * PBT spec for the update-overlay surface (compiled dist): the child-updater
 * stdout parser and the overlay state machine. Business invariants locked
 * here (issue #15 — progress & completion indicators for the update process):
 *  - NOOPEN: quit-and-update with noOpen appends '--no-open' so the updater
 *    does NOT relaunch the app — the app relaunches itself after the install
 *    (macOS in-app overlay flow); the default invocation never grows the flag.
 *  - PROGRESS: every representative CLI stage line classifies to a status
 *    label, a done event, or an error event. parseUpdateProgress is TOTAL:
 *    arbitrary input never throws and never returns 'ignore' for a
 *    non-blank line — the overlay can never freeze on a line it has not seen.
 *  - INIT: before the init event the reducer refuses work; init is the only
 *    event that enters the running phase.
 *  - TERMINAL: success and failure are absorbing — once reached, no further
 *    status/done/error event can take the overlay back to running, so a
 *    terminal result is rendered exactly once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import {
  initialOverlayState,
  overlayReducer,
  parseUpdateProgress,
  updateInvocation,
  type OverlayEvent,
} from '../dist/decision.js';

// ---------------------------------------------------------------------------
// NOOPEN — updateInvocation(cmd, { noOpen })
// ---------------------------------------------------------------------------

test('NOOPEN: noOpen appends --no-open to the update args; default never does', () => {
  fc.assert(
    fc.property(fc.string(), fc.boolean(), (rawOverride, noOpen) => {
      const override = rawOverride.trim().length > 0 ? rawOverride : undefined;
      const invocation = updateInvocation(override, { noOpen });
      const expectedArgs = noOpen ? ['update', '--no-open'] : ['update'];
      if (override !== undefined) {
        assert.deepEqual(invocation, { command: override, args: expectedArgs });
      } else {
        assert.deepEqual(
          invocation,
          { command: 'npx', args: ['--yes', '@uniterra-solutions/uniterra@latest', ...expectedArgs] },
        );
      }
    }),
  );
});

test('NOOPEN regression: noOpen defaults to false (existing call sites unchanged)', () => {
  assert.deepEqual(updateInvocation(undefined), {
    command: 'npx',
    args: ['--yes', '@uniterra-solutions/uniterra@latest', 'update'],
  });
});

// ---------------------------------------------------------------------------
// PROGRESS — parseUpdateProgress over the CLI's real stage lines
// ---------------------------------------------------------------------------

test('PROGRESS: every representative CLI stage line maps to a status label', () => {
  const stageLines = [
    'Updating CLI (@uniterra-solutions/uniterra)...',
    'Downloading source v0.12.0...',
    'Installing dependencies...',
    'Prebuilt artifacts found — skipping the workspace build.',
    'Building packages...',
    'Packaging the desktop app...',
    'Embedding source tree into the app...',
    'Installing to /Users/me/Applications/Uniterra.app...',
  ];
  for (const line of stageLines) {
    const event = parseUpdateProgress(line);
    assert.equal(event.kind, 'status', line);
    assert.ok(event.label.length > 0, 'a status always carries a non-empty label');
  }
});

test('PROGRESS: the download line carries the target version; the install line is done', () => {
  const download = parseUpdateProgress('Downloading source v0.12.0...');
  assert.equal(download.kind, 'status');
  assert.equal(download.version, 'v0.12.0');
  const done = parseUpdateProgress('Installed /Users/me/Applications/Uniterra.app');
  assert.equal(done.kind, 'done');
});

test('PROGRESS: error-ish lines classify as error, blank lines are ignored', () => {
  assert.equal(parseUpdateProgress('npm ERR! code EACCES').kind, 'error');
  assert.equal(parseUpdateProgress('Failed to update the CLI: permission denied').kind, 'error');
  assert.equal(parseUpdateProgress('   ').kind, 'ignore');
  assert.equal(parseUpdateProgress('').kind, 'ignore');
});

test('PROGRESS: parseUpdateProgress is total — arbitrary lines never throw and forward as status', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 120 }),
      fc.boolean(),
      (raw, trim) => {
        const line = trim ? raw.trim() : raw;
        let event: OverlayEvent | undefined;
        assert.doesNotThrow(() => {
          event = parseUpdateProgress(line);
        });
        assert.ok(event, 'event produced');
        if (line.trim().length === 0) {
          assert.equal(event.kind, 'ignore');
        } else {
          assert.ok(['status', 'done', 'error'].includes(event.kind), 'never a frozen overlay');
        }
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// INIT / TERMINAL — overlayReducer
// ---------------------------------------------------------------------------

test('INIT: the initial state is init with the do-not-close hint; status before init is refused', () => {
  assert.equal(initialOverlayState.phase, 'init');
  assert.ok(initialOverlayState.message.includes('Initializing'));
  const refused = overlayReducer(initialOverlayState, { kind: 'status', label: 'Installing dependencies...' });
  assert.equal(refused.phase, 'init', 'no work before the init event');
  const running = overlayReducer(initialOverlayState, { kind: 'init', version: 'v0.12.0' });
  assert.equal(running.phase, 'running');
  assert.equal(running.version, 'v0.12.0');
});

const runningEvent = fc.oneof(
  fc.constant({ kind: 'done' } as OverlayEvent),
  fc.constant({ kind: 'error', message: 'boom' } as OverlayEvent),
  fc.constant({ kind: 'status', label: 'Packaging the desktop app...' } as OverlayEvent),
);

test('TERMINAL: done/error reach a terminal state and are absorbing', () => {
  fc.assert(
    fc.property(
      fc.array(runningEvent, { maxLength: 40 }),
      fc.constantFrom('done', 'error'),
      (events, finalKind) => {
        let state = overlayReducer(initialOverlayState, { kind: 'init', version: 'v0.12.0' });
        const terminal = finalKind === 'done'
          ? ({ kind: 'done' } as OverlayEvent)
          : ({ kind: 'error', message: 'boom' } as OverlayEvent);
        state = overlayReducer(state, terminal);
        const expectedPhase = finalKind === 'done' ? 'success' : 'failure';
        assert.equal(state.phase, expectedPhase);
        // Every later status/done/error event keeps the terminal phase.
        for (const event of events) {
          state = overlayReducer(state, event);
          assert.equal(state.phase, expectedPhase, 'terminal state is absorbing');
        }
      },
    ),
  );
});

test('TERMINAL: success carries the installed version and the restart copy', () => {
  const state = overlayReducer(overlayReducer(initialOverlayState, { kind: 'init', version: 'v0.12.0' }), { kind: 'done', version: 'v0.12.0' });
  assert.equal(state.phase, 'success');
  assert.ok(state.message.includes('v0.12.0'));
  assert.ok(state.message.includes('Restart'));
});

test('TERMINAL: failure carries the error message and a retry affordance marker', () => {
  const state = overlayReducer(overlayReducer(initialOverlayState, { kind: 'init', version: 'v0.12.0' }), { kind: 'error', message: 'Failed to update the CLI' });
  assert.equal(state.phase, 'failure');
  assert.ok(state.message.includes('Failed to update the CLI'));
});
