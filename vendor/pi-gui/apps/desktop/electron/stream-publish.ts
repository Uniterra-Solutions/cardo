// Cardo: coalesced window delivery for session-event streams.
//
// The driver emits one event per text delta and the store re-publishes the full
// state + full transcript per event; forwarding every push to the renderer makes
// the UI fall irrecoverably behind the backend on long tasks (the agent
// finishes, the UI is still replaying the backlog). This module bounds window
// pushes to at most one per wall-clock interval regardless of event rate,
// always carrying the LATEST state (trailing edge) and delivering isolated
// updates immediately (leading edge).
//
// The decision logic is pure (`decideStreamPublish`) so the PBT suite can
// verify the liveness contract without timers; `createCoalescedPublisher` is the
// timer wrapper the desktop main process uses.
export const STREAM_PUBLISH_INTERVAL_MS = 80;

export interface StreamPublishState {
  /** A trailing push is already pending; it will carry the latest state. */
  readonly pending: boolean;
  /** Millisecond epoch of the last actual push. */
  readonly lastRunAt: number;
}

export type StreamPublishDecision =
  | { readonly kind: "publish-now" }
  | { readonly kind: "schedule"; readonly delayMs: number }
  | { readonly kind: "wait" };

export function decideStreamPublish(
  state: StreamPublishState,
  intervalMs: number,
  nowMs: number,
): StreamPublishDecision {
  if (state.pending) {
    return { kind: "wait" };
  }
  if (nowMs - state.lastRunAt >= intervalMs) {
    return { kind: "publish-now" };
  }
  return { kind: "schedule", delayMs: intervalMs - (nowMs - state.lastRunAt) };
}

export interface CoalescedPublisher {
  /** Coalesce a push request: at most one push per interval, always latest. */
  schedule(): void;
  /** Cancel any pending trailing push (used when the subscriber is torn down). */
  dispose(): void;
}

export function createCoalescedPublisher(
  publish: () => void,
  intervalMs: number = STREAM_PUBLISH_INTERVAL_MS,
): CoalescedPublisher {
  let pending = false;
  let lastRunAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    lastRunAt = Date.now();
    publish();
  };

  return {
    schedule() {
      const decision = decideStreamPublish({ pending, lastRunAt }, intervalMs, Date.now());
      if (decision.kind === "wait") {
        return;
      }
      if (decision.kind === "publish-now") {
        run();
        return;
      }
      pending = true;
      timer = setTimeout(() => {
        pending = false;
        timer = undefined;
        run();
      }, decision.delayMs);
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = false;
    },
  };
}
