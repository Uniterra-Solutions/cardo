/**
 * Jovaltus plan PIPELINE progress — the widget/status protocol the plan tool
 * pushes to the host so the desktop can render a progress strip above the
 * composer (PRD → clarify → design → plan), mirroring the execute panel.
 * (Distinct from `plan-progress.ts`, the execute-phase per-agent machine.)
 *
 * Lines: `STATUS|<running|done>` and `PHASE|<name>|<pending|running|done>`.
 * Values never contain '|', so the frontend splits on the first field.
 */

export const JOVALTUS_PLAN_WIDGET_KEY = 'jovaltus-plan';
export const JOVALTUS_PLAN_STATUS_KEY = 'jovaltus-plan';

export type PlanPhaseName = 'prd' | 'clarify' | 'design' | 'plan';
export type PlanPhaseState = 'pending' | 'running' | 'done';

export interface PlanPhaseProgress {
  readonly name: PlanPhaseName;
  readonly state: PlanPhaseState;
}

export interface PlanProgressState {
  readonly status: 'running' | 'done';
  readonly phases: readonly PlanPhaseProgress[];
}

/** The plan pipeline stages, in order (the `plan` stage = parked at plan_waiting). */
export const PLAN_PHASE_ORDER: readonly PlanPhaseName[] = ['prd', 'clarify', 'design', 'plan'];

export function planProgressInitial(): PlanProgressState {
  return {
    status: 'running',
    phases: PLAN_PHASE_ORDER.map((name) => ({ name, state: 'pending' })),
  };
}

function withPhase(
  state: PlanProgressState,
  name: PlanPhaseName,
  phaseState: PlanPhaseState,
): PlanProgressState {
  return {
    ...state,
    phases: state.phases.map((phase) =>
      phase.name === name ? { name, state: phaseState } : phase,
    ),
  };
}

/** Transition: a phase begins running. */
export function planProgressStartPhase(
  state: PlanProgressState,
  name: PlanPhaseName,
): PlanProgressState {
  return withPhase(state, name, 'running');
}

/** Transition: a phase completes. */
export function planProgressCompletePhase(
  state: PlanProgressState,
  name: PlanPhaseName,
): PlanProgressState {
  return withPhase(state, name, 'done');
}

/** Terminal state: the pipeline is parked at plan_waiting (green light). */
export function planProgressDone(state: PlanProgressState): PlanProgressState {
  return { ...state, status: 'done' };
}

export function buildPlanProgressLines(state: PlanProgressState): string[] {
  const lines: string[] = [`STATUS|${state.status}`];
  for (const phase of state.phases) {
    lines.push(`PHASE|${phase.name}|${phase.state}`);
  }
  return lines;
}
