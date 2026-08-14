/**
 * Cardo PBT: cardo update-check decision logic.
 *
 * Locks down:
 *  - resolveCardoUpdateStatus: error exactly when both published-version
 *    lookups failed; update-available exactly when either component is newer;
 *    latestVersion is the newest of the two published versions; currentVersion
 *    is the newest of the installed app/CLI versions.
 *  - shouldPromptForUpdate: no prompt without a known latest version or when
 *    the latest version is the skipped one (or older); prompt otherwise.
 *  - compareSemver: antisymmetry + prerelease ordering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  compareSemver,
  resolveCardoUpdateStatus,
  shouldPromptForUpdate,
} from "../../out-pbt/desktop/electron/cardo-update-logic.js";

const NUM_RUNS = 100;

const VERSION = fc.stringMatching(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
);
const OPT_VERSION = fc.option(VERSION, { nil: undefined });

const VERSIONS = fc.record({
  appVersion: VERSION,
  cliVersion: OPT_VERSION,
  latestReleaseVersion: OPT_VERSION,
  latestCliVersion: OPT_VERSION,
});

function newestOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return compareSemver(a, b) >= 0 ? a : b;
}

test("resolveCardoUpdateStatus: error exactly when both published-version lookups failed", () => {
  fc.assert(
    fc.property(VERSIONS, (versions) => {
      const result = resolveCardoUpdateStatus(versions);
      const bothUnknown =
        versions.latestReleaseVersion === undefined && versions.latestCliVersion === undefined;
      assert.equal(result.status === "error", bothUnknown);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("resolveCardoUpdateStatus: update-available exactly when either component is newer", () => {
  fc.assert(
    fc.property(VERSIONS, (versions) => {
      const result = resolveCardoUpdateStatus(versions);
      if (result.status === "error") {
        return;
      }
      const releaseNewer =
        versions.latestReleaseVersion !== undefined &&
        compareSemver(versions.latestReleaseVersion, versions.appVersion) > 0;
      const cliNewer =
        versions.cliVersion !== undefined &&
        versions.latestCliVersion !== undefined &&
        compareSemver(versions.latestCliVersion, versions.cliVersion) > 0;
      assert.equal(result.status === "update-available", releaseNewer || cliNewer);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("resolveCardoUpdateStatus: latestVersion/currentVersion are the newest of their pair", () => {
  fc.assert(
    fc.property(VERSIONS, (versions) => {
      const result = resolveCardoUpdateStatus(versions);
      if (result.status === "error") {
        return;
      }
      const expectedLatest = newestOf(versions.latestReleaseVersion, versions.latestCliVersion);
      const expectedCurrent = newestOf(versions.appVersion, versions.cliVersion) ?? versions.appVersion;
      if (result.status === "update-available") {
        assert.equal(result.latestVersion, expectedLatest);
      }
      assert.equal(result.currentVersion, expectedCurrent);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("shouldPromptForUpdate: prompt iff a newer-than-skipped latest version is known", () => {
  fc.assert(
    fc.property(OPT_VERSION, OPT_VERSION, (latest, skipped) => {
      const expected =
        latest !== undefined && (skipped === undefined || compareSemver(latest, skipped) > 0);
      assert.equal(shouldPromptForUpdate(latest, skipped), expected);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("compareSemver: antisymmetric on parseable versions", () => {
  const signOf = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
  fc.assert(
    fc.property(VERSION, VERSION, (a, b) => {
      const left = signOf(compareSemver(a, b));
      const right = signOf(compareSemver(b, a));
      assert.ok(
        (left > 0 && right < 0) || (left < 0 && right > 0) || (left === 0 && right === 0),
        `expected antisymmetric ordering for ${a} vs ${b}`,
      );
      assert.equal(signOf(compareSemver(a, a)), 0);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("compareSemver: prerelease precedence per semver", () => {
  assert.ok(compareSemver("0.4.0", "0.3.1") > 0);
  assert.ok(compareSemver("0.3.1", "0.4.0") < 0);
  // A release outranks its own prerelease.
  assert.ok(compareSemver("0.4.0", "0.4.0-beta.1") > 0);
  assert.ok(compareSemver("0.4.0-beta.1", "0.4.0") < 0);
  // A future-minor prerelease is still newer than the current release.
  assert.ok(compareSemver("0.4.0-beta.1", "0.3.1") > 0);
  // Numeric and dot-separated prerelease ordering.
  assert.ok(compareSemver("0.4.0-beta.2", "0.4.0-beta.1") > 0);
  assert.ok(compareSemver("0.4.0-rc.1", "0.4.0-beta.1") > 0);
  assert.ok(compareSemver("0.4.0-alpha", "0.4.0-alpha.1") < 0);
  // Unparseable inputs compare equal so we never claim an update we can't verify.
  assert.equal(compareSemver("not-a-version", "0.4.0"), 0);
  assert.equal(compareSemver("0.4.0", "garbage"), 0);
});
