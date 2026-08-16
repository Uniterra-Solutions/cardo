import test from 'node:test';
import assert from 'node:assert/strict';
import { stopRunningAppInstances, type ProcessOps } from '../dist/stop-app.js';

interface FakeOpsConfig {
  readonly pids: () => readonly number[];
  readonly quitError?: Error;
}

function fakeOps(config: FakeOpsConfig): { readonly ops: ProcessOps; readonly calls: string[] } {
  const calls: string[] = [];
  const ops: ProcessOps = {
    pgrep: async (bundleName) => {
      calls.push(`pgrep:${bundleName}`);
      return [...config.pids()];
    },
    osascriptQuit: async () => {
      calls.push('quit');
      if (config.quitError !== undefined) {
        throw config.quitError;
      }
    },
    kill: async (pids, signal) => {
      calls.push(`kill:${signal}:${pids.join(',')}`);
    },
    sleep: async () => {
      calls.push('sleep');
    },
  };
  return { ops, calls };
}

test('no-op when nothing is running: only probes once, never quits or kills', async () => {
  const { ops, calls } = fakeOps({ pids: () => [] });
  await stopRunningAppInstances(ops, { gracefulWaitMs: 1000, pollIntervalMs: 5 });
  assert.deepEqual(calls, ['pgrep:cardo']);
});

test('graceful quit stops immediately when the app exits on AppleScript quit', async () => {
  let pgrepCount = 0;
  const { ops, calls } = fakeOps({
    pids: () => (pgrepCount++ === 0 ? [42] : []),
  });
  await stopRunningAppInstances(ops, { gracefulWaitMs: 1000, pollIntervalMs: 5 });
  assert.deepEqual(calls, ['pgrep:cardo', 'quit', 'pgrep:cardo']);
});

test('everything quitting during the grace period avoids any force-kill', async () => {
  let pgrepCount = 0;
  const { ops, calls } = fakeOps({
    pids: () => (pgrepCount++ < 2 ? [42] : []),
  });
  await stopRunningAppInstances(ops, { gracefulWaitMs: 1000, pollIntervalMs: 5 });
  assert.deepEqual(calls, ['pgrep:cardo', 'quit', 'pgrep:cardo', 'sleep', 'pgrep:cardo']);
});

test('stragglers still alive after the grace period are SIGKILLed', async () => {
  const { ops, calls } = fakeOps({ pids: () => [42] });
  await stopRunningAppInstances(ops, { gracefulWaitMs: 30, pollIntervalMs: 5 });
  assert.equal(calls[0], 'pgrep:cardo');
  assert.equal(calls[1], 'quit');
  assert.ok(calls.some((call) => call === 'kill:SIGKILL:42'));
});

test('an AppleScript quit error is tolerated and force-kill still applies', async () => {
  const { ops, calls } = fakeOps({ pids: () => [7], quitError: new Error('not running') });
  await stopRunningAppInstances(ops, { gracefulWaitMs: 30, pollIntervalMs: 5 });
  assert.ok(calls.includes('quit'));
  assert.ok(calls.some((call) => call === 'kill:SIGKILL:7'));
});

test('multiple instances are passed to a single kill call and the bundle name is honoured', async () => {
  const { ops, calls } = fakeOps({ pids: () => [42, 43] });
  await stopRunningAppInstances(ops, {
    bundleName: 'cardo',
    gracefulWaitMs: 30,
    pollIntervalMs: 5,
  });
  assert.equal(calls[0], 'pgrep:cardo');
  assert.ok(calls.some((call) => call === 'kill:SIGKILL:42,43'));
});
