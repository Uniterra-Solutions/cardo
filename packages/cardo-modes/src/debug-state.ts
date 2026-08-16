/**
 * Debug-mode session state — the durable `debug/mode` event and its pure
 * fold, mirroring the plan-mode domain (`plan/mode` + `foldPlanMode`).
 *
 * The state in force is always a pure fold of the session log, so resume,
 * fork, and compaction recover it with no live mirror.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records one user selection of debug mode; whole-value replace. */
    'debug/mode': { active: boolean };
  }
}

/**
 * Whether debug mode is active after the first `end` events. The last
 * `debug/mode` wins; a prefix with none is inactive.
 *
 * @param events The session log or any prefix of it.
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns Whether debug mode is active.
 */
export function foldDebugMode(events: readonly SessionEvent[], end = events.length): boolean {
  let active = false;
  let index = 0;
  for (const event of events) {
    if (index >= end) break;
    index += 1;
    if (event.type === 'debug/mode') active = event.data.active;
  }
  return active;
}
