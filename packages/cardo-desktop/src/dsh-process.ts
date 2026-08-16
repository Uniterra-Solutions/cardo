/**
 * dsh runtime supervision — spawn the bundled DeepSeek Harness CLI as a
 * child, wait for its readiness line, expose the served URL, and own
 * shutdown/crash-restart. This is the entire "harness runtime" contract of
 * the cardo desktop app: the Electron shell is a thin window over the dsh
 * Web UI, exactly like a browser would load it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';

export interface DshRuntimeOptions {
  /** Absolute path to the dsh CLI entry (lib/bin.js). */
  readonly cli: string;
  /** Node executable to run the CLI with. */
  readonly nodeExec: string;
  /** The app-owned DSH_HOME. */
  readonly dshHome: string;
  /** The profile name to boot (cardo). */
  readonly profile: string;
  /** Optional explicit port; defaults to the CLI's own (3080). */
  readonly port?: number;
  /** Optional extra CLI args. */
  readonly args?: readonly string[];
}

export interface DshRuntimeHandle {
  readonly url: string;
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
}

/** Wait for the dsh readiness URL line on stdout. */
export function awaitReadiness(stdout: Readable, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`dsh did not report readiness within ${String(timeoutMs)}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer);
      if (match !== null) {
        cleanup();
        resolve(match[0]);
      }
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      stdout.off('data', onData);
    };

    stdout.on('data', onData);
  });
}

/**
 * Start the dsh runtime child and resolve once the Web UI is ready.
 * The child owns its exit; callers should wire `exited` to restart/quit.
 */
export async function startDsh(options: DshRuntimeOptions): Promise<DshRuntimeHandle> {
  const args = ['--profile', options.profile];
  if (options.port !== undefined) {
    args.push('--port', String(options.port));
  }
  args.push(...(options.args ?? []));

  const child = spawn(options.nodeExec, [options.cli, ...args], {
    env: {
      ...process.env,
      DSH_HOME: options.dshHome,
      ELECTRON_RUN_AS_NODE: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });

  let stderrTail = '';
  child.stderr.on('data', (data: Buffer) => {
    stderrTail = (stderrTail + data.toString()).slice(-4000);
  });

  const stdout = child.stdout;

  const url = await awaitReadiness(stdout).catch((err: unknown) => {
    child.kill('SIGTERM');
    throw new Error(
      `dsh failed to start: ${err instanceof Error ? err.message : String(err)}\n${stderrTail}`,
    );
  });

  return { url, child, exited };
}

export async function stopDsh(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, timeoutMs))]);
  if (!child.killed) {
    child.kill('SIGKILL');
  }
}
