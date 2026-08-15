/**
 * Jovaltus plan mode — the plan/execute pipeline surface.
 *
 * Plan mode is a per-session toggle. While ON the main agent gains the
 * plan-mode pipeline tools (`plan`, `execute_plan`) and a system note
 * describing the pipeline; while OFF those tools are hidden and any direct
 * call is blocked by a `tool_call` gate (actionable reason, not a confusing
 * tool error). Mode state is persisted with `pi.appendEntry` so it survives
 * restarts/resumes.
 *
 * Toggle surface: `/planmode` command, shift+P shortcut (the TUI keeps
 * shift+tab for `app.thinking.cycle`), and the desktop composer's shift+tab
 * + mode button (the desktop submits `/planmode`). The desktop button reads
 * the live status under `JOVALTUS_MODE_STATUS_KEY`.
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

/** Register the plan-mode toggle surface, tool gating, and persistence. */
export function registerPlanMode(pi: ExtensionAPI): void {
  let enabled = false;
  let toolsBeforePlanMode: string[] | undefined;

  pi.registerFlag('plan-mode', {
    description: 'Start in plan mode (Jovaltus plan / execute_plan pipeline available)',
    type: 'boolean',
    default: false,
  });

  const isPlanModeTool = (name: string): boolean => PLAN_MODE_TOOLS.includes(name);

  function applyModeTools(): void {
    const current = pi.getActiveTools();
    if (enabled) {
      // Remember the pre-plan-mode tool set once so disabling restores it
      // exactly (mirrors the official plan-mode example).
      toolsBeforePlanMode = toolsBeforePlanMode ?? current;
      pi.setActiveTools([...new Set([...current, ...PLAN_MODE_TOOLS])]);
    } else {
      const base = toolsBeforePlanMode ?? current;
      pi.setActiveTools(base.filter((name) => !isPlanModeTool(name)));
      toolsBeforePlanMode = undefined;
    }
  }

  function setModeStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(JOVALTUS_MODE_STATUS_KEY, enabled ? 'plan mode' : 'standard');
  }

  function persist(): void {
    pi.appendEntry(MODE_ENTRY_TYPE, { enabled });
  }

  function toggleMode(ctx: ExtensionContext): void {
    enabled = !enabled;
    applyModeTools();
    setModeStatus(ctx);
    persist();
    ctx.ui.notify(
      enabled
        ? 'Plan mode on: plan and execute_plan are available'
        : 'Plan mode off: plan and execute_plan are hidden',
      'info',
    );
  }

  pi.registerCommand('planmode', {
    description: 'Toggle Jovaltus plan mode (plan / execute_plan pipeline)',
    handler: async (_args, ctx) => {
      toggleMode(ctx);
      await Promise.resolve();
    },
  });

  // TUI fallback: shift+tab is taken by app.thinking.cycle, so the TUI toggles
  // with bare shift+P (user-mandated).
  pi.registerShortcut('shift+p', {
    description: 'Toggle Jovaltus plan mode',
    handler: async (ctx) => {
      toggleMode(ctx);
      await Promise.resolve();
    },
  });

  // Hard gate: even if the model somehow calls a plan-mode tool while off,
  // fail fast with an actionable reason instead of a confusing tool error.
  pi.on('tool_call', (event) => {
    if (enabled) {
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

  // System note: the main agent should know what plan mode offers.
  pi.on('before_agent_start', (event) => {
    if (!enabled) {
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

  // Restore mode + tool set on session start / resume.
  pi.on('session_start', (_event, ctx) => {
    if (pi.getFlag('plan-mode') === true) {
      enabled = true;
    }
    const entries = ctx.sessionManager.getEntries();
    const last = [...entries].reverse().find((entry) => {
      const custom = entry as { type?: string; customType?: string; data?: { enabled?: boolean } };
      return custom.type === 'custom' && custom.customType === MODE_ENTRY_TYPE;
    }) as { data?: { enabled?: boolean } } | undefined;
    if (last?.data?.enabled !== undefined) {
      enabled = last.data.enabled;
    }
    applyModeTools();
    setModeStatus(ctx);
  });
}
