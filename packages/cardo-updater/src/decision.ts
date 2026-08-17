/**
 * Cardo update-check decision logic. Pure (no Electron, no fs) so the
 * startup-update prompt semantics are unit-testable. Ported from the old
 * pi-gui `cardo-update-logic.ts` with the npm package renamed.
 */

/**
 * Compare two semver strings. Returns a negative number when `a < b`, zero
 * when equal, positive when `a > b`. Handles prerelease precedence per
 * semver (a release outranks its own prereleases); unparseable inputs
 * compare equal so we never claim an update we cannot verify.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === undefined || pb === undefined) {
    return 0;
  }
  if (pa.nums[0] !== pb.nums[0]) {
    return pa.nums[0] < pb.nums[0] ? -1 : 1;
  }
  if (pa.nums[1] !== pb.nums[1]) {
    return pa.nums[1] < pb.nums[1] ? -1 : 1;
  }
  if (pa.nums[2] !== pb.nums[2]) {
    return pa.nums[2] < pb.nums[2] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

function parseSemver(
  version: string,
): { nums: [number, number, number]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined ? match[4].split('.') : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version without a prerelease tag has higher precedence than one with it.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? '';
    const right = b[index] ?? '';
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) {
        return delta < 0 ? -1 : 1;
      }
    } else if (leftNumeric) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

export interface CardoUpdateVersions {
  /** Version of the installed desktop app (app.getVersion()). */
  readonly appVersion: string;
  /** Version of the installed CLI (probed via `cardo --version`), if known. */
  readonly cliVersion: string | undefined;
  /** Newest published app version (cardo GitHub release tag), if known. */
  readonly latestReleaseVersion: string | undefined;
  /** Newest published CLI version (npm dist-tag latest), if known. */
  readonly latestCliVersion: string | undefined;
}

export type CardoUpdateResult =
  | {
      readonly status: 'update-available';
      readonly latestVersion: string;
      readonly currentVersion: string;
    }
  | { readonly status: 'up-to-date'; readonly currentVersion: string }
  | { readonly status: 'error'; readonly message: string };

/** The action the desktop takes after the update prompt's user response. */
export type CardoUpdateAction =
  | { readonly action: 'quit-and-update' }
  | { readonly action: 'skip-version'; readonly skippedVersion: string }
  | { readonly action: 'none' };

/**
 * Map the update prompt's user response onto the action to take. `cardo
 * update` is the single full-update command (CLI refresh + app rebuild +
 * relaunch), so Update Now always runs it — the desktop quits itself first
 * and the CLI relaunches the app when done.
 */
export function resolveUpdateAction(
  result: CardoUpdateResult,
  response: number,
): CardoUpdateAction {
  if (result.status !== 'update-available') {
    return { action: 'none' };
  }
  if (response === 0) {
    return { action: 'quit-and-update' };
  }
  if (response === 2) {
    return { action: 'skip-version', skippedVersion: result.latestVersion };
  }
  return { action: 'none' };
}

/** The spawn spec for the quit-and-update action. */
export interface UpdateInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How Update Now spawns the updater. Default: `npx --yes
 * @uniterra-solutions/cardo@latest update` — ALWAYS execute the latest
 * published updater, so a stale global `cardo` CLI (one that predates the
 * one-command full update and would only refresh the CLI, leaving the app
 * closed) can never be the binary that runs. `CARDO_UPDATE_COMMAND`
 * overrides the command for tests/dev (the args stay `['update']`).
 */
export function updateInvocation(commandOverride: string | undefined): UpdateInvocation {
  const override = commandOverride?.trim();
  if (override !== undefined && override.length > 0) {
    return { command: override, args: ['update'] };
  }
  return { command: 'npx', args: ['--yes', '@uniterra-solutions/cardo@latest', 'update'] };
}

/**
 * Combine the CLI and GitHub-release checks into one verdict. An update
 * exists when either published version is newer than its installed
 * counterpart; the reported latestVersion is the newest of the two (used as
 * the skip key). Unknown lookups are ignored — only when BOTH lookups fail
 * is it an error.
 */
export function resolveCardoUpdateStatus(versions: CardoUpdateVersions): CardoUpdateResult {
  const { appVersion, cliVersion, latestReleaseVersion, latestCliVersion } = versions;
  const latestVersion = newestOf(latestReleaseVersion, latestCliVersion);
  if (latestVersion === undefined) {
    return { status: 'error', message: 'Unable to determine the latest Cardo version.' };
  }

  const releaseNewer =
    latestReleaseVersion !== undefined && compareSemver(latestReleaseVersion, appVersion) > 0;
  const cliNewer =
    cliVersion !== undefined &&
    latestCliVersion !== undefined &&
    compareSemver(latestCliVersion, cliVersion) > 0;
  const currentVersion = newestOf(appVersion, cliVersion) ?? appVersion;

  if (releaseNewer || cliNewer) {
    return { status: 'update-available', latestVersion, currentVersion };
  }
  return { status: 'up-to-date', currentVersion };
}

/**
 * Whether the startup flow should prompt for `latestVersion` given a version
 * the user previously chose to skip: prompt unless the latest version is the
 * skipped one (or older — a skipped version is never re-prompted).
 */
export function shouldPromptForUpdate(
  latestVersion: string | undefined,
  skippedVersion: string | undefined,
): boolean {
  if (latestVersion === undefined) {
    return false;
  }
  if (skippedVersion === undefined) {
    return true;
  }
  return compareSemver(latestVersion, skippedVersion) > 0;
}

function newestOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return compareSemver(a, b) >= 0 ? a : b;
}
