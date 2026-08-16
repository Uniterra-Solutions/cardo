// Cardo: Jovaltus plan-mode UI — mode toggle button, execute panel, and the
// right-side execution graph popup.
//
// All data comes from the jovaltus extension's live records (see
// packages/jovaltus/src/plan-mode.ts for the widget line protocol):
//   - mode state:   ctx.ui.setStatus("jovaltus-mode", "plan mode" | "standard")
//   - execute panel: ctx.ui.setWidget("jovaltus-execute", lines)
// where the widget lines are `TAG|value...`:
//   STATUS|<running|done>  MODE|<mode>  STEP|<n>  BATCH|<i>|<ids>  AGENT|<id>|<state>
//
// The graph popup renders the execution graph natively from those structured
// lines — it is derived from the same JSON the execution-plan was parsed
// from, never parsed from free text or mermaid source.
import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, CloseIcon } from "./icons";

export type JovaltusAgentState = "pending" | "running" | "done";

export interface JovaltusExecuteModel {
  readonly status: "running" | "done";
  readonly mode: string;
  /** 0-based index of the batch currently executing; -1 when done. */
  readonly stepIndex: number;
  readonly batches: readonly (readonly string[])[];
  readonly agents: ReadonlyMap<string, JovaltusAgentState>;
}

const AGENT_STATES: readonly JovaltusAgentState[] = ["pending", "running", "done"];

export function parseJovaltusExecuteWidget(lines: readonly string[]): JovaltusExecuteModel | undefined {
  let status: "running" | "done" | undefined;
  let mode = "";
  let stepIndex = 0;
  const batches: string[][] = [];
  const agents = new Map<string, JovaltusAgentState>();
  for (const line of lines) {
    const separatorIndex = line.indexOf("|");
    if (separatorIndex === -1) {
      continue;
    }
    const tag = line.slice(0, separatorIndex);
    const rest = line.slice(separatorIndex + 1).split("|");
    switch (tag) {
      case "STATUS":
        status = rest[0] === "done" ? "done" : "running";
        break;
      case "MODE":
        mode = rest[0] ?? "";
        break;
      case "STEP": {
        const parsed = Number(rest[0]);
        if (Number.isFinite(parsed)) {
          stepIndex = parsed;
        }
        break;
      }
      case "BATCH": {
        const index = Number(rest[0]);
        if (Number.isInteger(index) && index >= 0) {
          batches[index] = (rest[1] ?? "").split(",").filter((id) => id.length > 0);
        }
        break;
      }
      case "AGENT": {
        const id = rest[0];
        const state = rest[1];
        if (id !== undefined && state !== undefined && AGENT_STATES.includes(state as JovaltusAgentState)) {
          agents.set(id, state as JovaltusAgentState);
        }
        break;
      }
      default:
        break;
    }
  }
  if (status === undefined) {
    return undefined;
  }
  const compactBatches = batches.filter((batch) => batch.length > 0);
  return { status, mode, stepIndex, batches: compactBatches, agents };
}

/** Mode toggle button for the composer (reads live extension status). */
export function JovaltusModeButton({
  planModeOn,
  onToggle,
}: {
  readonly planModeOn: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      aria-pressed={planModeOn}
      className={`jovaltus-mode ${planModeOn ? "jovaltus-mode--on" : ""}`}
      data-testid="jovaltus-mode-button"
      title={planModeOn ? "Plan mode on — shift+tab to turn off" : "Plan mode off — shift+tab to turn on"}
      type="button"
      onClick={onToggle}
    >
      <span className="jovaltus-mode__dot" aria-hidden="true" />
      <span className="jovaltus-mode__label">plan</span>
    </button>
  );
}

/**
 * Execute panel above the composer: pulsing light + agent progress while
 * running, green light when done, then auto-fades after 3s. Click opens the
 * graph popup.
 */
export function JovaltusExecutePanel({
  model,
  onOpenGraph,
}: {
  readonly model: JovaltusExecuteModel;
  readonly onOpenGraph: () => void;
}) {
  const [faded, setFaded] = useState(false);
  const previousStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (model.status === previousStatusRef.current) {
      return;
    }
    previousStatusRef.current = model.status;
    if (model.status === "done") {
      const timer = window.setTimeout(() => setFaded(true), 3000);
      return () => window.clearTimeout(timer);
    }
    setFaded(false);
    return undefined;
  }, [model.status]);

  if (faded) {
    return null;
  }

  const total = model.batches.reduce((count, batch) => count + batch.length, 0);
  const doneCount = [...model.agents.values()].filter((state) => state === "done").length;
  const running = model.status === "running";

  return (
    <button
      className="jovaltus-execute"
      data-testid="jovaltus-execute-panel"
      title={running ? "Open the execution graph" : "Execution complete — open the graph"}
      type="button"
      onClick={onOpenGraph}
    >
      <span
        aria-hidden="true"
        className={`jovaltus-execute__light ${running ? "jovaltus-execute__light--running" : "jovaltus-execute__light--done"}`}
      >
        <span className="jovaltus-execute__spinner" />
      </span>
      <span className="jovaltus-execute__text">
        {running
          ? `executing plan · ${String(doneCount)}/${String(total)} agents · ${model.mode}`
          : `plan executed · ${String(doneCount)}/${String(total)} agents`}
      </span>
      <ChevronRightIcon />
    </button>
  );
}

/**
 * Plan pipeline progress panel above the composer: pulsing light + phase
 * chips while planning (PRD → clarify → design → plan), green light when the
 * plan is parked at `plan_waiting`, then auto-fades after 3s. Mirrors the
 * execute panel so both pipeline stages read the same way.
 */
export type JovaltusPlanPhaseState = "pending" | "running" | "done";

export interface JovaltusPlanPhase {
  readonly name: string;
  readonly label: string;
  readonly state: JovaltusPlanPhaseState;
}

export interface JovaltusPlanModel {
  readonly status: "running" | "done";
  readonly phases: readonly JovaltusPlanPhase[];
}

const PLAN_PHASE_LABELS: Readonly<Record<string, string>> = {
  prd: "PRD",
  clarify: "clarify",
  design: "design",
  plan: "plan",
};

export function parseJovaltusPlanWidget(lines: readonly string[]): JovaltusPlanModel | undefined {
  let status: "running" | "done" | undefined;
  const phases: JovaltusPlanPhase[] = [];
  for (const line of lines) {
    const separatorIndex = line.indexOf("|");
    if (separatorIndex === -1) {
      continue;
    }
    const tag = line.slice(0, separatorIndex);
    const rest = line.slice(separatorIndex + 1).split("|");
    if (tag === "STATUS") {
      status = rest[0] === "done" ? "done" : "running";
    } else if (tag === "PHASE") {
      const name = rest[0];
      const state = rest[1];
      if (name !== undefined && (state === "pending" || state === "running" || state === "done")) {
        phases.push({ name, label: PLAN_PHASE_LABELS[name] ?? name, state });
      }
    }
  }
  if (status === undefined) {
    return undefined;
  }
  return { status, phases };
}

export function JovaltusPlanPanel({ model }: { readonly model: JovaltusPlanModel }) {
  const [faded, setFaded] = useState(false);
  const previousStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (model.status === previousStatusRef.current) {
      return;
    }
    previousStatusRef.current = model.status;
    if (model.status === "done") {
      const timer = window.setTimeout(() => setFaded(true), 3000);
      return () => window.clearTimeout(timer);
    }
    setFaded(false);
    return undefined;
  }, [model.status]);

  if (faded) {
    return null;
  }

  const running = model.status === "running";
  const runningPhase = model.phases.find((phase) => phase.state === "running");
  const doneCount = model.phases.filter((phase) => phase.state === "done").length;

  return (
    <div className="jovaltus-plan" data-testid="jovaltus-plan-panel">
      <span
        aria-hidden="true"
        className={`jovaltus-plan__light ${running ? "jovaltus-plan__light--running" : "jovaltus-plan__light--done"}`}
      >
        <span className="jovaltus-execute__spinner" />
      </span>
      <span className="jovaltus-plan__text">
        {running
          ? `planning · ${String(doneCount)}/${String(model.phases.length)} phases${runningPhase ? ` · ${runningPhase.label}` : ""}`
          : `plan ready · ${String(doneCount)}/${String(model.phases.length)} phases`}
      </span>
      <span className="jovaltus-plan__phases" aria-hidden="true">
        {model.phases.map((phase) => (
          <span
            className={`jovaltus-plan__phase jovaltus-plan__phase--${phase.state}`}
            data-testid={`jovaltus-plan-phase-${phase.name}`}
            key={phase.name}
          >
            {phase.state === "done" ? "✓" : phase.state === "running" ? "●" : "○"} {phase.label}
          </span>
        ))}
      </span>
    </div>
  );
}

/** Right-side graph popup: batches → agent nodes colored by live state. */
export function JovaltusGraphPopup({
  model,
  onClose,
}: {
  readonly model: JovaltusExecuteModel;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="jovaltus-graph-backdrop"
      data-testid="jovaltus-graph-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        aria-label="Execution graph"
        className="jovaltus-graph"
        data-testid="jovaltus-graph-panel"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="jovaltus-graph__header">
          <span className="jovaltus-graph__title">execution graph</span>
          <button aria-label="Close execution graph" className="jovaltus-graph__close" type="button" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="jovaltus-graph__body">
          {model.batches.map((ids, batchIndex) => {
            const active = batchIndex === model.stepIndex;
            return (
              <div
                className={`jovaltus-graph__batch ${active ? "jovaltus-graph__batch--active" : ""}`}
                key={batchIndex}
              >
                <div className="jovaltus-graph__batch-label">
                  batch {String(batchIndex + 1)} of {String(model.batches.length)}
                </div>
                <div className="jovaltus-graph__nodes">
                  {ids.map((id) => {
                    const state = model.agents.get(id) ?? "pending";
                    return (
                      <div className={`jovaltus-graph__node jovaltus-graph__node--${state}`} key={id}>
                        <span className="jovaltus-graph__node-icon" aria-hidden="true">
                          {state === "running" ? <span className="jovaltus-execute__spinner" /> : null}
                        </span>
                        <span className="jovaltus-graph__node-id">{id}</span>
                      </div>
                    );
                  })}
                </div>
                {batchIndex < model.batches.length - 1 ? (
                  <div className="jovaltus-graph__edge" aria-hidden="true">
                    ↓
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <footer className="jovaltus-graph__legend">
          <span className="jovaltus-graph__legend-item">
            <span className="jovaltus-graph__legend-dot jovaltus-graph__legend-dot--done" /> done
          </span>
          <span className="jovaltus-graph__legend-item">
            <span className="jovaltus-graph__legend-dot jovaltus-graph__legend-dot--running" /> running
          </span>
          <span className="jovaltus-graph__legend-item">
            <span className="jovaltus-graph__legend-dot" /> pending
          </span>
        </footer>
      </aside>
    </div>
  );
}
