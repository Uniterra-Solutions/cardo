import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, OrchestrationChildThread, SelectedTranscriptRecord } from "../desktop-state";
import { applyTranscriptDelta } from "../transcript-delta";
import { applyStateDelta, type StateSlices } from "../state-delta";

export function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<SelectedTranscriptRecord | null>(null);

  // Cardo: T2 moved orchestrationChildren off the per-push state payload onto
  // its own channel, so pushed full states (state-changed) arrive WITHOUT the
  // slice while IPC responses (getState / updateSnapshot) still carry it. This
  // ref holds the latest value seen from any full state or the
  // orchestration-changed channel; slices-only pushes are completed from it so
  // the renderer's final DesktopAppState always carries the slice.
  const orchestrationRef = useRef<readonly OrchestrationChildThread[] | null>(null);

  // Cardo: the hook's setSnapshot is the single write path for BOTH the pushed
  // channels (state-changed / state-delta / orchestration-changed) and the
  // IPC-response helper (updateSnapshot). Any full state flowing through it
  // keeps the orchestration ref in sync, so a later slices-only push always
  // merges the CURRENT orchestrationChildren.
  const setSnapshotWithOrchestration = useCallback(
    (action: SetStateAction<DesktopAppState | null>) => {
      setSnapshot((current) => {
        const next = typeof action === "function" ? action(current) : action;
        if (next) {
          orchestrationRef.current = next.orchestrationChildren;
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let receivedPushedTranscript = false;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    // The initial getState() can resolve after an early pushed state-changed event; never let a
    // snapshot with a lower revision overwrite a newer one already applied to state.
    const applyState = (incoming: StateSlices | DesktopAppState) => {
      if ("orchestrationChildren" in incoming) {
        // Full DesktopAppState (IPC responses): the revision guard lives in
        // applySnapshotIfNewer; the setter syncs the orchestration ref.
        applySnapshotIfNewer(setSnapshotWithOrchestration, incoming);
        return;
      }
      // Cardo: pushed full state (state-changed) arrives orchestration-stripped
      // (T2): complete it from the local ref under the same revision guard.
      setSnapshotWithOrchestration((current) => {
        if (current && incoming.revision < current.revision) {
          return current;
        }
        const latestOrchestration = orchestrationRef.current;
        if (latestOrchestration === null) {
          // No full state has arrived yet (the in-flight getState() response
          // seeds the ref) — a slices-only push cannot be completed, so drop it.
          return current;
        }
        return { ...incoming, orchestrationChildren: latestOrchestration };
      });
    };

    void Promise.all([api.getState(), api.getSelectedTranscript()]).then(([state, transcript]) => {
      if (!active) {
        return;
      }
      applyState(state);
      // SelectedTranscriptRecord carries no revision marker, so the stale initial transcript is
      // only applied when no pushed transcript has arrived yet.
      if (!receivedPushedTranscript) {
        setSelectedTranscript(transcript);
      }
    });

    const unsubscribeState = api.onStateChanged((state) => {
      if (active) {
        applyState(state);
      }
    });
    const unsubscribeTranscript = api.onSelectedTranscriptChanged((payload) => {
      if (active) {
        receivedPushedTranscript = true;
        setSelectedTranscript(payload);
      }
    });
    // Cardo: incremental transcript delivery. The main process sends the full
    // snapshot on session switch (onSelectedTranscriptChanged above) and only
    // changed items afterwards. Applying ops locally keeps the object identity
    // of untouched items, so the timeline memo comparator short-circuits on
    // reference equality instead of JSON.stringify-ing every row per push.
    const unsubscribeTranscriptDelta = api.onTranscriptDelta((payload) => {
      if (!active) {
        return;
      }
      receivedPushedTranscript = true;
      setSelectedTranscript((current) => {
        if (
          !current ||
          current.workspaceId !== payload.workspaceId ||
          current.sessionId !== payload.sessionId
        ) {
          // Not the selected session yet; the full snapshot will arrive on switch.
          return current;
        }
        return {
          ...current,
          transcript: applyTranscriptDelta(current.transcript, payload.ops),
        };
      });
    });
    // Cardo: incremental state delivery. The main process sends the full
    // (orchestration-stripped) state on session switch / first publish /
    // recovery and only changed slices afterwards. Applying ops locally keeps
    // untouched slices reference-identical, so memo comparators short-circuit;
    // the revision guard mirrors applySnapshotIfNewer's (never let a stale or
    // duplicate delta roll the state back).
    const unsubscribeStateDelta = api.onStateDelta((payload) => {
      if (!active) {
        return;
      }
      setSnapshotWithOrchestration((current) => {
        if (!current || payload.revision <= current.revision) {
          return current;
        }
        return applyStateDelta(current, payload.ops);
      });
    });
    // Cardo: orchestrationChildren (child-thread transcripts + evidence) leaves
    // the per-push state payload and arrives on its own channel,
    // reference-changed only. Update the local ref first so subsequent
    // slices-only pushes merge the freshest value, then re-merge one slice into
    // the snapshot — all other slices keep their object identity.
    const unsubscribeOrchestration = api.onOrchestrationChanged((payload) => {
      if (!active) {
        return;
      }
      orchestrationRef.current = payload.orchestrationChildren;
      setSnapshotWithOrchestration((current) => {
        if (!current) {
          return current;
        }
        return { ...current, orchestrationChildren: payload.orchestrationChildren };
      });
    });

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeTranscript();
      unsubscribeTranscriptDelta();
      unsubscribeStateDelta();
      unsubscribeOrchestration();
    };
  }, []);

  return [snapshot, setSnapshotWithOrchestration, selectedTranscript] as const;
}

/**
 * Never let a state snapshot with a lower revision overwrite a newer one. IPC
 * responses race the pushed state-changed events: a response is built when the
 * handler returns, but concurrent session events can bump the state (and get
 * pushed) before the response crosses the IPC boundary. Applying the stale
 * response unguarded would silently roll the UI back — e.g. a /name rename
 * right after an aborted run lost its title this way.
 */
export function applySnapshotIfNewer(
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  incoming: DesktopAppState,
): void {
  setSnapshot((current) => (current && incoming.revision < current.revision ? current : incoming));
}

export function updateSnapshot(
  api: NonNullable<typeof window.piApp>,
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  action: () => Promise<DesktopAppState>,
) {
  return action().then((state) => {
    applySnapshotIfNewer(setSnapshot, state);
    return state;
  });
}
