/**
 * In-app update overlay flow (issue #15): run `uniterra update --no-open` as
 * a CHILD PROCESS (not detached) and drive the overlay state machine from its
 * stdout/stderr. Deliberately Electron-free (the Electron wiring — window,
 * close guard, relaunch — lives in main.ts) so the spawn contract and the
 * state transitions are unit-testable without launching the app.
 *
 * Lifecycle: the initial state (Phase 1 "Initializing update..." message) is
 * surfaced before any work; the init event enters the running phase with the
 * target version; stdout/stderr lines stream through parseUpdateProgress into
 * overlayReducer; a clean exit 0 reaches success and calls onSuccess (the app
 * relaunches itself — FR-15.5); a non-zero exit, a killed child, or a spawn
 * error reaches failure with a retry affordance (FR-15.6). Re-running the
 * flow restarts from scratch, so a retry reinstalls the app from scratch and
 * repairs a partial install.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  initialOverlayState,
  overlayReducer,
  parseUpdateProgress,
  type OverlayEvent,
  type OverlayState,
  type UpdateInvocation,
} from '@uniterra-solutions/uniterra-updater';

/** How the overlay update spawns the updater: a plain child process with
 * piped stdio — never detached, never stdio-ignored (FR-15.4). */
export interface OverlaySpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

export function overlaySpawnSpec(invocation: UpdateInvocation): OverlaySpawnSpec {
  return {
    command: invocation.command,
    args: [...invocation.args],
    options: { detached: false, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface OverlayUpdateCallbacks {
  /** Every overlay state change, including the initial and terminal states. */
  readonly onState: (state: OverlayState) => void;
  /** The update finished successfully — the app should relaunch itself. */
  readonly onSuccess: () => void;
}

export interface StartOverlayUpdateOptions {
  /** The updater invocation (updateInvocation(cmd, { noOpen: true })). */
  readonly invocation: UpdateInvocation;
  /** The target version from the update prompt (init/success copy). */
  readonly version: string;
  readonly callbacks: OverlayUpdateCallbacks;
  /** Injectable spawn for tests; defaults to node:child_process spawn. */
  readonly spawnFn?: SpawnFunction;
}

export function startOverlayUpdate(options: StartOverlayUpdateOptions): void {
  const { invocation, version, callbacks } = options;
  const spawnFn: SpawnFunction = options.spawnFn ?? spawn;
  let state: OverlayState = initialOverlayState;
  const setState = (next: OverlayState): void => {
    if (next === state) {
      return;
    }
    state = next;
    callbacks.onState(next);
  };
  const dispatch = (event: OverlayEvent): void => {
    setState(overlayReducer(state, doneWithTargetVersion(event, state.version)));
  };
  const streamLines = (input: Readable): void => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line: string) => {
      dispatch(parseUpdateProgress(line));
    });
  };

  // FR-15.1: Phase 1 (initialization) is surfaced before any work starts.
  callbacks.onState(initialOverlayState);
  // FR-15.2: the init event enters the running phase with the target version.
  setState(overlayReducer(state, { kind: 'init', version }));

  const spec = overlaySpawnSpec(invocation);
  let child: ChildProcess;
  try {
    child = spawnFn(spec.command, spec.args, spec.options);
  } catch (error) {
    dispatch({
      kind: 'error',
      message: `Failed to start the updater: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  if (child.stdout !== null) {
    streamLines(child.stdout);
  }
  if (child.stderr !== null) {
    streamLines(child.stderr);
  }
  child.once('error', (error: Error) => {
    dispatch({
      kind: 'error',
      message: `Failed to start the updater: ${error.message}`,
    });
  });
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (code === 0) {
      // The CLI's final "Installed ..." line may already have reached the
      // success phase; a done event after that is absorbed by the reducer.
      dispatch({ kind: 'done' });
      if (state.phase === 'success') {
        // FR-15.5: relaunch immediately (no await) — the app re-executes the
        // freshly installed bundle at the same path.
        callbacks.onSuccess();
      }
      return;
    }
    // A non-zero exit OR a killed child (code null + signal) is a failure:
    // the overlay shows the error with retry, and re-running the updater
    // reinstalls from scratch, repairing a partial install (FR-15.1/15.6).
    const reason =
      code !== null
        ? `exited with code ${String(code)}`
        : `was terminated (${signal ?? 'unknown signal'})`;
    dispatch({ kind: 'error', message: `The update process ${reason}` });
  });
}

/** A done event always carries the target version so the success copy reads
 * "Update to <version> completed..." even when the CLI's final line does not
 * print the version (FR-15.3). */
function doneWithTargetVersion(event: OverlayEvent, version: string | undefined): OverlayEvent {
  if (event.kind !== 'done' || event.version !== undefined || version === undefined) {
    return event;
  }
  return { kind: 'done', version };
}
