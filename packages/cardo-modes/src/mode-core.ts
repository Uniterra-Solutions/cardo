/**
 * Cardo mode core — the pure per-session mode state machine (`standard |
 * plan | debug`). Exactly one mode is active at a time; `standard` means
 * neither non-standard mode is active.
 *
 * This module is intentionally harness-free: every function is pure and
 * total so the property-based suite (`test/pbt/mode-core.test.mts`) can lock
 * the invariants without a backend. The harness wiring lives in
 * `index.ts` (plan → native `ctx.planMode`, debug → logged `debug/mode`
 * state + `debug:policy` section + `/debug` command).
 */

export type CardoMode = 'standard' | 'plan' | 'debug';

/** Fixed cycle order for the desktop mode button (standard → plan → debug). */
export const MODE_CYCLE: readonly CardoMode[] = ['standard', 'plan', 'debug'];

/** Cycle successor: standard → plan → debug → standard (total). */
export function nextMode(mode: CardoMode): CardoMode {
  switch (mode) {
    case 'standard':
      return 'plan';
    case 'plan':
      return 'debug';
    case 'debug':
      return 'standard';
  }
}

/** The status text reported to the UI for a mode. */
export function modeToStatusText(mode: CardoMode): string {
  switch (mode) {
    case 'standard':
      return 'standard';
    case 'plan':
      return 'plan mode';
    case 'debug':
      return 'debug mode';
  }
}

/** Total inverse of `modeToStatusText`; unknown/missing text maps to standard. */
export function statusTextToMode(text: string | undefined): CardoMode {
  if (text === 'plan mode') {
    return 'plan';
  }
  if (text === 'debug mode') {
    return 'debug';
  }
  return 'standard';
}

/** Plan toggle: plan ↔ standard, debug → plan. */
export function togglePlanMode(mode: CardoMode): CardoMode {
  switch (mode) {
    case 'plan':
      return 'standard';
    case 'standard':
      return 'plan';
    case 'debug':
      return 'plan';
  }
}

/** Debug toggle: debug ↔ standard, plan → debug. */
export function toggleDebugMode(mode: CardoMode): CardoMode {
  switch (mode) {
    case 'debug':
      return 'standard';
    case 'standard':
      return 'debug';
    case 'plan':
      return 'debug';
  }
}

/**
 * Restore precedence on session start: the persisted mode wins; otherwise
 * the plan flag wins over the debug flag; otherwise standard.
 */
export function restoreMode(
  flags: { readonly plan: boolean; readonly debug: boolean },
  persisted: CardoMode | undefined,
): CardoMode {
  if (persisted !== undefined) {
    return persisted;
  }
  if (flags.plan) {
    return 'plan';
  }
  if (flags.debug) {
    return 'debug';
  }
  return 'standard';
}

/** The debug workflow note (English, ASCII, self-contained). */
export const DEBUG_MODE_NOTE =
  '[DEBUG MODE]\n' +
  'The user is reporting a bug. Before changing any code, complete this workflow in order:\n' +
  '1. Read and search the relevant business logic under investigation.\n' +
  '2. Define that business logic as invariants and reproduce the bug via property-based testing.\n' +
  '3. Fix the bug, then add or complete unit tests as regression tests.';
