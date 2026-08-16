/**
 * Stop running Cardo desktop app instances before `cardo update` replaces the
 * app bundle. Process interaction is injected so the flow is unit-testable.
 */

export interface ProcessOps {
  /** PIDs of processes whose command line contains `<bundleName>.app`. */
  readonly pgrep: (bundleName: string) => Promise<number[]>;
  /** Graceful quit via AppleScript (lets Electron flush persistence). */
  readonly osascriptQuit: (bundleName: string) => Promise<void>;
  readonly kill: (pids: readonly number[], signal: NodeJS.Signals) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface StopAppOptions {
  readonly bundleName?: string;
  /** How long to wait for a graceful quit before force-killing. */
  readonly gracefulWaitMs?: number;
  readonly pollIntervalMs?: number;
}

export const APP_BUNDLE_NAME = 'cardo';
export const DEFAULT_GRACEFUL_WAIT_MS = 10_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Quit every running instance of the app bundle: AppleScript `quit` first so
 * Electron's before-quit persistence flush runs, then poll for exit and
 * SIGKILL whatever is still alive after the grace period. No-op when nothing
 * is running.
 */
export async function stopRunningAppInstances(
  ops: ProcessOps,
  options: StopAppOptions = {},
): Promise<void> {
  const bundleName = options.bundleName ?? APP_BUNDLE_NAME;
  const gracefulWaitMs = options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if ((await ops.pgrep(bundleName)).length === 0) {
    return;
  }

  try {
    await ops.osascriptQuit(bundleName);
  } catch {
    // App is not running or AppleScript is unavailable; force-kill covers it.
  }

  const deadline = Date.now() + gracefulWaitMs;
  while (Date.now() < deadline) {
    if ((await ops.pgrep(bundleName)).length === 0) {
      return;
    }
    await ops.sleep(pollIntervalMs);
  }

  const stragglers = await ops.pgrep(bundleName);
  if (stragglers.length > 0) {
    await ops.kill(stragglers, 'SIGKILL');
  }
}
