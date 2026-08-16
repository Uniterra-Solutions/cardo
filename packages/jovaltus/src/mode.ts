/**
 * Cardo mode registry — the pure per-session mode core (`standard | plan |
 * debug`) shared by plan mode and debug mode. Exactly one mode is active at
 * a time; `standard` means neither non-standard mode is active (FR-1).
 *
 * This module is intentionally pi-free: every function is pure and total so
 * the property-based suite (`test/pbt/mode.test.mts`) can lock the design
 * doc's §5 invariants without a backend. The pi wiring lives in
 * `plan-mode.ts` (`ModeController` + `registerPlanMode` / `registerDebugMode`).
 */

export type CardoMode = 'standard' | 'plan' | 'debug';

/** The active tool set plus the pre-plan base captured on first entry. */
export interface ToolSetState {
  readonly active: readonly string[];
  readonly baseBeforePlan: readonly string[] | undefined;
}

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

/** The status text reported under `JOVALTUS_MODE_STATUS_KEY` (FR-5). */
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

/** Persistence payload for the `jovaltus-mode` entry (design D4). */
export function modeEntryWrite(mode: CardoMode): { mode: CardoMode } {
  return { mode };
}

/**
 * Total read of a persisted `jovaltus-mode` entry: the `{ mode }` shape
 * wins, the legacy `{ enabled }` shape maps plan on/off, and anything else
 * (missing, malformed, garbage) is standard. Never throws.
 */
export function modeEntryRead(data: unknown): CardoMode {
  if (typeof data !== 'object' || data === null) {
    return 'standard';
  }
  const record = data as { readonly mode?: unknown; readonly enabled?: unknown };
  if (record.mode === 'standard' || record.mode === 'plan' || record.mode === 'debug') {
    return record.mode;
  }
  if (record.enabled === true) {
    return 'plan';
  }
  return 'standard';
}

/** Plan toggle: plan ↔ standard, debug → plan (FR-1 / design D2). */
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

/** Debug toggle: debug ↔ standard, plan → debug (FR-1 / design D2). */
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
 * the plan flag wins over the debug flag; otherwise standard (design D8).
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

/** The exact FR-7 debug workflow note (English, ASCII, self-contained). */
export const DEBUG_MODE_NOTE =
  '[DEBUG MODE]\n' +
  'The user is reporting a bug. Before changing any code, complete this workflow in order:\n' +
  '1. Read and search the relevant business logic under investigation.\n' +
  '2. Define that business logic as invariants and reproduce the bug via property-based testing.\n' +
  '3. Fix the bug, then add or complete unit tests as regression tests.';

/** Append the debug note to the system prompt, preserving the base prefix. */
export function debugPromptAppend(systemPrompt: string): string {
  return `${systemPrompt}\n\n${DEBUG_MODE_NOTE}`;
}

/**
 * Pure tool-set transition (design D9): entering plan captures the pre-plan
 * base once and adds the plan tools; any other mode restores the base minus
 * the plan tools and forgets the capture. Debug never adds tools.
 */
export function applyModeTools(
  state: ToolSetState,
  mode: CardoMode,
  planTools: readonly string[],
): ToolSetState {
  if (mode === 'plan') {
    const base = state.baseBeforePlan ?? state.active;
    return { active: [...new Set([...base, ...planTools])], baseBeforePlan: base };
  }
  const base = state.baseBeforePlan ?? state.active;
  return {
    active: base.filter((tool) => !planTools.includes(tool)),
    baseBeforePlan: undefined,
  };
}
