/**
 * PBT spec for the uniterra update decision logic (compiled dist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import {
  compareSemver,
  resolveUniterraUpdateStatus,
  resolveUpdateAction,
  shouldPromptForUpdate,
  updateInvocation,
  type UniterraUpdateResult,
} from '../dist/decision.js';

const semverArb = fc
  .tuple(
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
  )
  .map(([a, b, c]) => `${a}.${b}.${c}`);

test('compareSemver: total ordering with identity and reflexivity', () => {
  fc.assert(
    fc.property(semverArb, semverArb, semverArb, (a, b, c) => {
      assert.equal(compareSemver(a, a), 0, 'reflexive');
      const ab = compareSemver(a, b);
      const ba = compareSemver(b, a);
      assert.ok(
        (ab > 0 && ba < 0) || (ab < 0 && ba > 0) || (ab === 0 && ba === 0),
        'antisymmetric',
      );
      // transitivity on the sign
      const bc = compareSemver(b, c);
      if (ab > 0 && bc > 0) assert.ok(compareSemver(a, c) > 0, 'transitive >');
      if (ab < 0 && bc < 0) assert.ok(compareSemver(a, c) < 0, 'transitive <');
    }),
  );
});

test('compareSemver: prerelease ranks below release', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareSemver('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.10'), -1);
});

test('compareSemver: unparseable inputs compare equal', () => {
  assert.equal(compareSemver('garbage', '1.0.0'), 0);
  assert.equal(compareSemver('', '1.0.0'), 0);
});

test('resolveUniterraUpdateStatus: error when both lookups fail', () => {
  const result = resolveUniterraUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: undefined,
    latestReleaseVersion: undefined,
    latestCliVersion: undefined,
  });
  assert.equal(result.status, 'error');
});

test('resolveUniterraUpdateStatus: update when release newer than app', () => {
  const result = resolveUniterraUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: '1.0.0',
    latestReleaseVersion: '1.1.0',
    latestCliVersion: '1.0.0',
  });
  assert.equal(result.status, 'update-available');
  assert.equal(result.latestVersion, '1.1.0');
});

test('resolveUniterraUpdateStatus: update when CLI newer than installed CLI', () => {
  const result = resolveUniterraUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: '1.0.0',
    latestReleaseVersion: '1.0.0',
    latestCliVersion: '1.1.0',
  });
  assert.equal(result.status, 'update-available');
  assert.equal(result.latestVersion, '1.1.0');
});

test('resolveUniterraUpdateStatus: up-to-date when nothing newer', () => {
  const result = resolveUniterraUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: '1.0.0',
    latestReleaseVersion: '1.0.0',
    latestCliVersion: '1.0.0',
  });
  assert.equal(result.status, 'up-to-date');
});

test('resolveUniterraUpdateStatus: unknown CLI lookup ignored, release drives', () => {
  const result = resolveUniterraUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: undefined,
    latestReleaseVersion: '1.0.0',
    latestCliVersion: undefined,
  });
  assert.equal(result.status, 'up-to-date');
});

test('resolveUniterraUpdateStatus: latestVersion is the newest of the two', () => {
  fc.assert(
    fc.property(semverArb, semverArb, (release, cli) => {
      const result = resolveUniterraUpdateStatus({
        appVersion: '0.0.1',
        cliVersion: '0.0.1',
        latestReleaseVersion: release,
        latestCliVersion: cli,
      });
      if (result.status === 'error') {
        assert.fail('should not error with known inputs');
      }
      const newest = compareSemver(release, cli) >= 0 ? release : cli;
      if (result.status === 'update-available') {
        assert.equal(result.latestVersion, newest);
      }
    }),
  );
});

test('shouldPromptForUpdate: prompts when no skip recorded, never re-prompts a skipped version', () => {
  assert.equal(shouldPromptForUpdate(undefined, undefined), false);
  assert.equal(shouldPromptForUpdate('1.1.0', undefined), true);
  assert.equal(shouldPromptForUpdate('1.1.0', '1.1.0'), false);
  assert.equal(shouldPromptForUpdate('1.1.0', '1.2.0'), false);
  assert.equal(shouldPromptForUpdate('1.2.0', '1.1.0'), true);
});

test('resolveUpdateAction: Update Now = quit-and-update; Skip persists; else none', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('update-available', 'up-to-date', 'error'),
      semverArb,
      fc.integer({ min: -1, max: 3 }),
      (status, version, response) => {
        const result: UniterraUpdateResult =
          status === 'update-available'
            ? { status, latestVersion: version, currentVersion: '0.0.1' }
            : status === 'up-to-date'
              ? { status, currentVersion: '0.0.1' }
              : { status, message: 'probe failed' };
        const action = resolveUpdateAction(result, response);
        if (status === 'update-available' && response === 0) {
          assert.deepEqual(action, { action: 'quit-and-update' }, 'Update Now quits and updates');
        } else if (status === 'update-available' && response === 2) {
          assert.deepEqual(
            action,
            { action: 'skip-version', skippedVersion: version },
            'Skip persists the version that was offered',
          );
        } else {
          assert.deepEqual(action, { action: 'none' }, 'anything else takes no action');
        }
      },
    ),
  );
});

test('updateInvocation: default runs the latest updater via npx; override keeps update args', () => {
  fc.assert(
    fc.property(fc.string(), fc.boolean(), (rawOverride, useDefault) => {
      const override = useDefault ? undefined : rawOverride;
      const invocation = updateInvocation(override);
      const trimmed = rawOverride.trim();
      if (override !== undefined && trimmed.length > 0) {
        assert.deepEqual(
          invocation,
          { command: override, args: ['update'] },
          'an explicit override replaces only the command',
        );
      } else {
        assert.deepEqual(
          invocation,
          { command: 'npx', args: ['--yes', '@uniterra-solutions/uniterra@latest', 'update'] },
          'the default always executes the latest published updater',
        );
      }
    }),
  );
});
