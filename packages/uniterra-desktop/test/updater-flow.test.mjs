/**
 * Unit spec for the in-app update overlay flow (issue #15, compiled dist).
 *
 * Business invariants locked here (the overlay is macOS-only; Windows keeps
 * the existing quit-first detached flow):
 *  - SPAWN: the overlay update spawns the updater as a CHILD PROCESS (never
 *    detached, stdio piped) with `--no-open` — the app stays alive and
 *    streams the updater's output into the overlay (FR-15.4).
 *  - INIT: consent surfaces the Phase-1 message, then the init event enters
 *    the running phase with the target version (FR-15.1/15.2).
 *  - DONE: the process ends with an explicit success ("Update to <version>
 *    completed. Restarting Uniterra...") or failure copy — never a silent
 *    frozen state — and the relaunch callback fires only on a clean exit 0
 *    (FR-15.3/15.5).
 *  - FAILURE: a non-zero exit, a killed child, or a spawn error reaches the
 *    failure phase with a retry affordance and never relaunches (FR-15.6);
 *    an error line wins even over a later exit 0.
 *  - RETRY: re-running the overlay restarts from scratch (init → running) —
 *    the updater reinstalls from scratch, repairing a partial install.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { overlaySpawnSpec, startOverlayUpdate } from '../dist/update-overlay.js';

const OVERLAY_INVOCATION = {
  command: 'npx',
  args: ['--yes', '@uniterra-solutions/uniterra@latest', 'update', '--no-open'],
};

/** A minimal child stand-in: an EventEmitter with piped stdout/stderr. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

/** Run the overlay once with the given spawnFn; returns { states, relaunched }. */
function runOnce(spawnFn) {
  const states = [];
  const captured = { relaunched: false };
  startOverlayUpdate({
    invocation: OVERLAY_INVOCATION,
    version: '0.12.0',
    callbacks: {
      onState: (state) => states.push(state),
      onSuccess: () => {
        captured.relaunched = true;
      },
    },
    spawnFn,
  });
  return { states, captured };
}

// ---------------------------------------------------------------------------
// SPAWN — the overlay update is a piped child process, never detached
// ---------------------------------------------------------------------------

test('SPAWN: overlaySpawnSpec produces a piped, non-detached child with --no-open args', () => {
  const spec = overlaySpawnSpec(OVERLAY_INVOCATION);
  assert.equal(spec.command, 'npx');
  assert.deepEqual(spec.args, OVERLAY_INVOCATION.args);
  assert.equal(spec.options.detached, false, 'never detached');
  assert.deepEqual(spec.options.stdio, ['ignore', 'pipe', 'pipe'], 'stdio piped');
});

test('SPAWN: startOverlayUpdate spawns exactly the overlay spec', () => {
  const child = fakeChild();
  let seen;
  startOverlayUpdate({
    invocation: OVERLAY_INVOCATION,
    version: '0.12.0',
    callbacks: { onState: () => {}, onSuccess: () => {} },
    spawnFn: (command, args, options) => {
      seen = { command, args, options };
      return child;
    },
  });
  assert.deepEqual(seen, {
    command: 'npx',
    args: ['--yes', '@uniterra-solutions/uniterra@latest', 'update', '--no-open'],
    options: { detached: false, stdio: ['ignore', 'pipe', 'pipe'] },
  });
});

// ---------------------------------------------------------------------------
// INIT — Phase 1 first, then running(version)
// ---------------------------------------------------------------------------

test('INIT: the initial state is surfaced before the running phase', () => {
  const child = fakeChild();
  const { states } = runOnce(() => child);
  assert.equal(states[0].phase, 'init');
  assert.ok(states[0].message.includes('Initializing'), states[0].message);
  assert.ok(states[0].message.includes('Do not close'), states[0].message);
  assert.equal(states[1].phase, 'running');
  assert.equal(states[1].version, '0.12.0');
  assert.ok(states[1].message.includes('Updating to 0.12.0'), states[1].message);
});

// ---------------------------------------------------------------------------
// DONE — explicit success copy + relaunch only on a clean exit 0
// ---------------------------------------------------------------------------

test('DONE: CLI stage lines stream through the overlay; exit 0 relaunches', async () => {
  const child = fakeChild();
  const { states, captured } = runOnce(() => child);

  child.stdout.write('Downloading source v0.12.0...\n');
  child.stdout.write('Installing dependencies...\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.relaunched, false, 'no relaunch while the child still runs');
  assert.ok(
    states.some((s) => s.message.includes('Downloading source v0.12.0')),
    'stage lines reach the overlay',
  );

  child.stderr.end();
  child.stdout.end();
  child.emit('close', 0, null);

  const last = states[states.length - 1];
  assert.equal(last.phase, 'success');
  assert.ok(last.message.includes('0.12.0'), last.message);
  assert.ok(last.message.includes('Restart'), last.message);
  assert.equal(captured.relaunched, true, 'clean exit 0 relaunches');
});

test('DONE: success without a CLI "Installed" line still names the target version', () => {
  const child = fakeChild();
  const { states, captured } = runOnce(() => child);
  child.emit('close', 0, null);
  const last = states[states.length - 1];
  assert.equal(last.phase, 'success');
  assert.ok(last.message.includes('0.12.0'), last.message);
  assert.ok(last.message.includes('Restarting Uniterra'), last.message);
  assert.equal(captured.relaunched, true);
});

test('DONE: blank lines are ignored — no phantom state changes', async () => {
  const child = fakeChild();
  const { states } = runOnce(() => child);
  const count = states.length; // init + running
  child.stdout.write('\n\n   \n');
  child.stderr.write('\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.length, count, 'blank lines never emit a state');
});

// ---------------------------------------------------------------------------
// FAILURE — error + retry affordance, never a relaunch
// ---------------------------------------------------------------------------

test('FAILURE: a non-zero exit reaches failure with retry guidance, no relaunch', () => {
  const child = fakeChild();
  const { states, captured } = runOnce(() => child);
  child.emit('close', 1, null);
  const last = states[states.length - 1];
  assert.equal(last.phase, 'failure');
  assert.ok(last.message.includes('code 1'), last.message);
  assert.ok(last.message.includes('Retry'), last.message);
  assert.equal(captured.relaunched, false);
});

test('FAILURE: killing the update child mid-run is treated as failure (FR-15.1)', () => {
  const child = fakeChild();
  const { states, captured } = runOnce(() => child);
  child.emit('close', null, 'SIGTERM');
  const last = states[states.length - 1];
  assert.equal(last.phase, 'failure');
  assert.ok(last.message.includes('SIGTERM'), last.message);
  assert.ok(last.message.includes('Retry'), last.message);
  assert.equal(captured.relaunched, false);
});

test('FAILURE: a spawn error reaches failure and absorbs the trailing close', () => {
  const child = fakeChild();
  const { states, captured } = runOnce(() => child);
  child.emit('error', new Error('spawn npx ENOENT'));
  assert.equal(states[states.length - 1].phase, 'failure');
  assert.ok(states[states.length - 1].message.includes('ENOENT'));
  // Node emits 'close' after a spawn error — the terminal state absorbs it.
  child.emit('close', null, null);
  assert.equal(states[states.length - 1].phase, 'failure');
  assert.equal(captured.relaunched, false);
});

test('FAILURE: an error line wins even when the child exits 0', async () => {
  const child = fakeChild();
  const { states, captured } = runOnce(() => child);
  child.stderr.write('npm ERR! code EACCES\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states[states.length - 1].phase, 'failure');
  child.emit('close', 0, null);
  assert.equal(states[states.length - 1].phase, 'failure', 'failure is absorbing');
  assert.equal(captured.relaunched, false, 'an error line never relaunches');
});

// ---------------------------------------------------------------------------
// RETRY — re-running the overlay reinstalls from scratch
// ---------------------------------------------------------------------------

test('RETRY: a second run restarts from scratch (init → running) with a fresh child', () => {
  const first = fakeChild();
  const second = fakeChild();
  const children = [first, second];
  const spawned = [];
  const states = [];
  const options = {
    invocation: OVERLAY_INVOCATION,
    version: '0.12.0',
    callbacks: {
      onState: (state) => states.push(state),
      onSuccess: () => {},
    },
    spawnFn: () => {
      const child = children[spawned.length];
      spawned.push(child);
      return child;
    },
  };

  startOverlayUpdate(options);
  first.emit('close', 1, null);
  assert.equal(states[states.length - 1].phase, 'failure');

  // Retry — the updater reinstalls from scratch (repairs a partial install).
  startOverlayUpdate(options);
  const tail = states.slice(-2);
  assert.equal(tail[0].phase, 'init', 'a retry surfaces Phase 1 again');
  assert.equal(tail[1].phase, 'running', 'a retry re-enters the running phase');
  assert.equal(spawned.length, 2, 'a fresh child is spawned on retry');

  second.emit('close', 0, null);
  assert.equal(states[states.length - 1].phase, 'success');
});
