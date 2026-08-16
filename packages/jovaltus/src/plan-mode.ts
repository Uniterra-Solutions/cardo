/**
 * Jovaltus plan mode — the plan/execute pipeline surface and the shared
 * cardo mode registry wiring (standard | plan | debug).
 *
 * The per-session mode is owned by a single `ModeController` (created once
 * in the factory): `plan` exposes the plan-mode pipeline tools
 * (`plan`, `execute_plan`) plus a system note, `debug` adds the
 * evidence-driven debug workflow note, and `standard` means neither is
 * active. The pure registry logic lives in `mode.ts`; this module is the
 * pi wiring (commands, flags, tool gate, persistence, status, prompt
 * appends, session_start restore).
 *
 * Toggle surface: `/planmode` + `/debugmode` commands, shift+P shortcut
 * (the TUI keeps shift+tab for `app.thinking.cycle`), and the desktop
 * composer's shift+tab + mode button (the desktop submits the mapped
 * command). The desktop button reads the live status under
 * `JOVALTUS_MODE_STATUS_KEY`.
 *
 * This module also owns the execute-panel widget protocol (key
 * `JOVALTUS_EXECUTE_WIDGET_KEY`): structured lines pushed with
 * `ctx.ui.setWidget` that the desktop renders as the execute panel (spinner
 * / green-light + per-agent states) and the right-side graph popup. The
 * graph is derived from the SAME JSON the execution-plan was parsed from —
 * the frontend never parses mermaid or free text.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ExecutionPlan } from './plan.js';
import {
  applyModeTools,
  debugPromptAppend,
  modeEntryRead,
  modeEntryWrite,
  modeToStatusText,
  restoreMode,
  toggleDebugMode,
  togglePlanMode,
  type CardoMode,
} from './mode.js';

export const PLAN_MODE_TOOLS: readonly string[] = ['plan', 'execute_plan'];
export const JOVALTUS_MODE_STATUS_KEY = 'jovaltus-mode';
export const JOVALTUS_EXECUTE_WIDGET_KEY = 'jovaltus-execute';
export const JOVALTUS_EXECUTE_STATUS_KEY = 'jovaltus-execute';

/** appendEntry type used to persist the mode across sessions. */
const MODE_ENTRY_TYPE = 'jovaltus-mode';

// Widget protocol ------------------------------------------------------------
// Lines: `STATUS|<running|done>`, `MODE|<mode>`, `STEP|<n>` (0-based current
// batch, -1 when done), `BATCH|<i>|<comma-joined ids>`, `AGENT|<id>|<state>`.
// Values never contain '|', so the frontend splits on the first field.

export type PlanAgentState = 'pending' | 'running' | 'done';
export type PlanExecutionStatus = 'running' | 'done';

export interface ExecuteWidgetState {
  readonly status: PlanExecutionStatus;
  readonly mode: string;
  /** 0-based index of the batch currently executing; -1 when done. */
  readonly stepIndex: number;
  readonly batches: readonly (readonly string[])[];
  readonly agents: ReadonlyMap<string, PlanAgentState>;
}

export function buildExecuteWidgetLines(state: ExecuteWidgetState): string[] {
  const lines: string[] = [
    `STATUS|${state.status}`,
    `MODE|${state.mode}`,
    `STEP|${String(state.stepIndex)}`,
  ];
  state.batches.forEach((ids, i) => {
    lines.push(`BATCH|${String(i)}|${ids.join(',')}`);
  });
  for (const [id, agentState] of state.agents) {
    lines.push(`AGENT|${id}|${agentState}`);
  }
  return lines;
}

/** Initial widget state: everything pending, step 0, mode from the plan. */
export function planExecuteWidgetInitial(plan: ExecutionPlan): ExecuteWidgetState {
  const batches = plan.batches.map((batch) => batch.map((agent) => agent.id));
  const agents = new Map<string, PlanAgentState>();
  for (const batch of batches) {
    for (const id of batch) {
      agents.set(id, 'pending');
    }
  }
  return { status: 'running', mode: plan.execution_mode, stepIndex: 0, batches, agents };
}

/** Transition: an agent in the current step begins running. */
export function planExecuteWidgetAgentStart(
  state: ExecuteWidgetState,
  id: string,
): ExecuteWidgetState {
  return { ...state, agents: new Map(state.agents).set(id, 'running') };
}

/** Transition: an agent finishes; update the current step index. */
export function planExecuteWidgetAgentDone(
  state: ExecuteWidgetState,
  id: string,
  stepIndex: number,
): ExecuteWidgetState {
  return { ...state, stepIndex, agents: new Map(state.agents).set(id, 'done') };
}

/** Terminal state: all agents done (green light, frontend auto-fades). */
export function planExecuteWidgetDone(state: ExecuteWidgetState): ExecuteWidgetState {
  return { ...state, status: 'done', stepIndex: -1 };
}

// Mode registry --------------------------------------------------------------

/**
 * Shared per-session mode state (standard | plan | debug), created once in
 * the factory. Owns the active mode plus the pre-plan base tool set captured
 * on first entry into plan mode (preserving the existing restore behavior).
 */
export class ModeController {
  private mode: CardoMode = 'standard';
  private toolsBeforePlan: readonly string[] | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  /** The currently active mode (defaults to standard). */
  get(): CardoMode {
    return this.mode;
  }

  /**
   * Toggle path: switch to `next`, re-apply the tool set, push the status
   * text under `JOVALTUS_MODE_STATUS_KEY`, and persist the new mode. Does
   * NOT notify — the caller owns the transition-specific notify string.
   */
  setMode(next: CardoMode, ctx: ExtensionContext): void {
    this.applyMode(next);
    ctx.ui.setStatus(JOVALTUS_MODE_STATUS_KEY, modeToStatusText(next));
    this.pi.appendEntry(MODE_ENTRY_TYPE, modeEntryWrite(next));
  }

  /**
   * Restore path (session_start): re-apply the tool set and push the status
   * WITHOUT writing a new entry — restoring must not clobber the persisted
   * history (last write wins stays intact).
   */
  restore(next: CardoMode, ctx: ExtensionContext): void {
    this.applyMode(next);
    ctx.ui.setStatus(JOVALTUS_MODE_STATUS_KEY, modeToStatusText(next));
  }

  private applyMode(next: CardoMode): void {
    this.mode = next;
    const updated = applyModeTools(
      { active: this.pi.getActiveTools(), baseBeforePlan: this.toolsBeforePlan },
      next,
      PLAN_MODE_TOOLS,
    );
    this.pi.setActiveTools([...updated.active]);
    this.toolsBeforePlan = updated.baseBeforePlan;
  }
}

// Notify strings per mode transition (exact wording, asserted in the PBT
// suite's `expectedNotify` — see test/pbt/debug-mode.test.mts).
const NOTIFY_PLAN_ON = 'Plan mode on: plan and execute_plan are available';
const NOTIFY_PLAN_OFF = 'Plan mode off: plan and execute_plan are hidden';
const NOTIFY_DEBUG_ON = 'Debug mode on: the agent follows the evidence-driven debug workflow';
const NOTIFY_DEBUG_OFF = 'Debug mode off: the agent follows the standard workflow';
const NOTIFY_DEBUG_ON_FROM_PLAN =
  'Debug mode on: plan mode off — the agent follows the evidence-driven debug workflow';
const NOTIFY_PLAN_ON_FROM_DEBUG =
  'Plan mode on: debug mode off — plan and execute_plan are available';

/** The info notify text for a `prev → next` mode transition. */
function notifyForTransition(prev: CardoMode, next: CardoMode): string {
  if (next === 'debug') {
    return prev === 'plan' ? NOTIFY_DEBUG_ON_FROM_PLAN : NOTIFY_DEBUG_ON;
  }
  if (next === 'standard') {
    return prev === 'debug' ? NOTIFY_DEBUG_OFF : NOTIFY_PLAN_OFF;
  }
  return prev === 'debug' ? NOTIFY_PLAN_ON_FROM_DEBUG : NOTIFY_PLAN_ON;
}

/** Register the plan-mode toggle surface, tool gating, and persistence. */
export function registerPlanMode(pi: ExtensionAPI, controller: ModeController): void {
  pi.registerFlag('plan-mode', {
    description: 'Start in plan mode (Jovaltus plan / execute_plan pipeline available)',
    type: 'boolean',
    default: false,
  });

  const isPlanModeTool = (name: string): boolean => PLAN_MODE_TOOLS.includes(name);

  pi.registerCommand('planmode', {
    description: 'Toggle Jovaltus plan mode (plan / execute_plan pipeline)',
    handler: async (_args, ctx) => {
      const prev = controller.get();
      const next = togglePlanMode(prev);
      controller.setMode(next, ctx);
      ctx.ui.notify(notifyForTransition(prev, next), 'info');
      await Promise.resolve();
    },
  });

  // TUI fallback: shift+tab is taken by app.thinking.cycle, so the TUI toggles
  // with bare shift+P (user-mandated).
  pi.registerShortcut('shift+p', {
    description: 'Toggle Jovaltus plan mode',
    handler: async (ctx) => {
      const prev = controller.get();
      const next = togglePlanMode(prev);
      controller.setMode(next, ctx);
      ctx.ui.notify(notifyForTransition(prev, next), 'info');
      await Promise.resolve();
    },
  });

  // Hard gate: even if the model somehow calls a plan-mode tool while the
  // mode is not plan, fail fast with an actionable reason instead of a
  // confusing tool error (debug mode keeps the gate — FR-12).
  pi.on('tool_call', (event) => {
    if (controller.get() === 'plan') {
      return;
    }
    if (!isPlanModeTool(event.toolName)) {
      return;
    }
    return {
      block: true,
      reason:
        `Jovaltus plan mode is off — ${event.toolName} is plan-mode only. ` +
        `Enable it with shift+tab (desktop), shift+P (terminal), or /planmode.`,
    };
  });

  // System note: the main agent should know what plan mode offers. Gated on
  // the mode being plan — debug never carries this note (the registry is
  // exclusive, FR-1).
  pi.on('before_agent_start', (event) => {
    if (controller.get() !== 'plan') {
      return;
    }
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n[JOVALTUS PLAN MODE]\n` +
        `You are in plan mode. plan and execute_plan are available: run plan to ` +
        `produce a PRD → requirement clarification → design doc → failing PBT ` +
        `spec (business logic as invariants) → execution-plan.json, then ` +
        `execute_plan <plan_id> to dispatch the plan's subagents. simplify / ` +
        `review / list_sessions / resume_session remain available.`,
    };
  });

  // The SINGLE session_start restore: both start flags + the last persisted
  // `jovaltus-mode` entry (persisted wins, design D8) → controller.
  pi.on('session_start', (_event, ctx) => {
    const planFlag = pi.getFlag('plan-mode') === true;
    const debugFlag = pi.getFlag('debug-mode') === true;
    const entries = ctx.sessionManager.getEntries();
    const last = [...entries].reverse().find((entry) => {
      const custom = entry as { type?: string; customType?: string; data?: unknown };
      return custom.type === 'custom' && custom.customType === MODE_ENTRY_TYPE;
    }) as { data?: unknown } | undefined;
    const persisted = last === undefined ? undefined : modeEntryRead(last.data);
    controller.restore(restoreMode({ plan: planFlag, debug: debugFlag }, persisted), ctx);
  });
}

/**
 * Register the debug-mode toggle surface and system-note append: the
 * `debug-mode` start flag (FR-3), the `/debugmode` command (FR-2), and a
 * `before_agent_start` note gated on the mode being debug (FR-6/FR-7). No
 * tools, no tool gate, no shortcut (FR-12/FR-13) — the shared registry is
 * exclusive, so enabling debug deactivates plan in the same invocation.
 */
export function registerDebugMode(pi: ExtensionAPI, controller: ModeController): void {
  pi.registerFlag('debug-mode', {
    description: 'Start in debug mode (evidence-driven debug workflow)',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('debugmode', {
    description: 'Toggle Jovaltus debug mode (evidence-driven debug workflow)',
    handler: async (_args, ctx) => {
      const prev = controller.get();
      const next = toggleDebugMode(prev);
      controller.setMode(next, ctx);
      ctx.ui.notify(notifyForTransition(prev, next), 'info');
      await Promise.resolve();
    },
  });

  // System note: the evidence-driven debug workflow, appended iff the mode is
  // debug; the base prompt is always preserved as the prefix (FR-6/FR-7).
  pi.on('before_agent_start', (event) => {
    if (controller.get() !== 'debug') {
      return;
    }
    return { systemPrompt: debugPromptAppend(event.systemPrompt) };
  });
}
