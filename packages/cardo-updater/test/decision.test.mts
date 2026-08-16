/**
 * PBT spec for the cardo update decision logic (compiled dist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import {
  compareSemver,
  resolveCardoUpdateStatus,
  shouldPromptForUpdate,
} from '../dist/decision.js';

const semverArb = fc
  .tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }))
  .map(([a, b, c]) => `${a}.${b}.${c}`);

test('compareSemver: total ordering with identity and reflexivity', () => {
  fc.assert(
    fc.property(semverArb, semverArb, semverArb, (a, b, c) => {
      assert.equal(compareSemver(a, a), 0, 'reflexive');
      const ab = compareSemver(a, b);
      const ba = compareSemver(b, a);
      assert.ok((ab > 0 && ba < 0) || (ab < 0 && ba > 0) || (ab === 0 && ba === 0), 'antisymmetric');
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

test('resolveCardoUpdateStatus: error when both lookups fail', () => {
  const result = resolveCardoUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: undefined,
    latestReleaseVersion: undefined,
    latestCliVersion: undefined,
  });
  assert.equal(result.status, 'error');
});

test('resolveCardoUpdateStatus: update when release newer than app', () => {
  const result = resolveCardoUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: '1.0.0',
    latestReleaseVersion: '1.1.0',
    latestCliVersion: '1.0.0',
  });
  assert.equal(result.status, 'update-available');
  assert.equal(result.latestVersion, '1.1.0');
});

test('resolveCardoUpdateStatus: update when CLI newer than installed CLI', () => {
  const result = resolveCardoUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: '1.0.0',
    latestReleaseVersion: '1.0.0',
    latestCliVersion: '1.1.0',
  });
  assert.equal(result.status, 'update-available');
  assert.equal(result.latestVersion, '1.1.0');
});

test('resolveCardoUpdateStatus: up-to-date when nothing newer', () => {
  const result = resolveCardoUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: '1.0.0',
    latestReleaseVersion: '1.0.0',
    latestCliVersion: '1.0.0',
  });
  assert.equal(result.status, 'up-to-date');
});

test('resolveCardoUpdateStatus: unknown CLI lookup ignored, release drives', () => {
  const result = resolveCardoUpdateStatus({
    appVersion: '1.0.0',
    cliVersion: undefined,
    latestReleaseVersion: '1.0.0',
    latestCliVersion: undefined,
  });
  assert.equal(result.status, 'up-to-date');
});

test('resolveCardoUpdateStatus: latestVersion is the newest of the two', () => {
  fc.assert(
    fc.property(semverArb, semverArb, (release, cli) => {
      const result = resolveCardoUpdateStatus({
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
