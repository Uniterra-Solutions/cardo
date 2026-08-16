import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, OrchestrationChildThread, SelectedTranscriptRecord } from "../desktop-state";
import { applyTranscriptDelta } from "../transcript-delta";
import { applyStateDelta, type StateDeltaPayload, type StateSlices } from "../state-delta";

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
  // Cardo: true once a full DesktopAppState has flowed through the setter
  // (the getState() seed or an IPC response). The pre-seed buffer/drain
  // decision keys off THIS, never off `orchestrationRef === null` —
  // orchestration-changed can arrive pre-seed and set the ref to a non-null
  // value, which would let a stale equal-revision seed overwrite a pushed
  // full (renderer-wiring W-CONV).
  const hasFullStateRef = useRef(false);
  // Cardo: a pushed full state (state-changed) that arrives BEFORE the
  // getState() response cannot be completed yet (the orchestration ref is
  // unseeded), so the latest one is BUFFERED instead of dropped. Otherwise a
  // stale seed response — built at mount time, before the first events —
  // strands the renderer at an older revision until the next push, which
  // never comes if that event was the last one (PBT renderer-wiring.test.mts
  // W-CONV counterexample: pushed rev 1 dropped, stale seed rev 0 applied →
  // permanent divergence). The buffer is drained by the first full state
  // (seed or later pushed full) that is at least as new.
  // NOTE: these refs live at hook top level (rules-of-hooks); the
  // pre-seed buffer is only written while the mount effect is live.
  const pendingFullRef = useRef<StateSlices | null>(null);
  // Cardo: pre-seed state-deltas are relative to the buffered full's state;
  // they are buffered in order and replayed after the seed + full drain
  // (a delta arriving before any snapshot used to be dropped, stranding the
  // renderer one revision behind the store forever — same W-CONV class).
  const pendingDeltaRef = useRef<StateDeltaPayload[]>([]);

  // Cardo: the hook's setSnapshot is the single write path for BOTH the pushed
  // channels (state-changed / state-delta / orchestration-changed) and the
  // IPC-response helper (updateSnapshot). Any full state flowing through it
  // keeps the orchestration ref in sync, so a later slices-only push always
  // merges the CURRENT orchestrationChildren.
  const setSnapshotWithOrchestration = useCallback(
    (action: SetStateAction<DesktopAppState | null>) => {
      // A plain VALUE action is a full DesktopAppState (the getState() seed or
      // an IPC response); pushed channels always pass function updaters. This
      // is the ONLY reliable "the renderer has seen a full state" signal —
      // orchestration-changed can arrive pre-seed and must not count.
      if (typeof action !== "function") {
        hasFullStateRef.current = true;
      }
      setSnapshot((current) => {
        const next = typeof action === "function" ? action(current) : action;
        if (next && orchestrationRef.current === null) {
          // Only the FIRST full state seeds the ref. Never regress it: a
          // stale seed/response whose orchestration predates a processed
          // orchestration-changed must not overwrite the fresher children
          // (renderer-wiring W-CONV); the orchestration-changed channel keeps
          // the ref current thereafter.
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
        // applySnapshotIfNewer. Then re-merge the freshest orchestration (a
        // stale seed's children must not regress the ref or the snapshot) and
        // drain any buffered pre-seed full — it reflects LATER main-process
        // state than the mount-time seed even at equal revision (session
        // switches are projections that do not bump revision).
        applySnapshotIfNewer(setSnapshotWithOrchestration, incoming);
        setSnapshotWithOrchestration((current) => {
          if (!current) {
            return current;
          }
          const pending = pendingFullRef.current;
          const latestOrchestration = orchestrationRef.current ?? current.orchestrationChildren;
          let next: DesktopAppState = current;
          if (pending !== null && pending.revision >= current.revision) {
            pendingFullRef.current = null;
            next = { ...pending, orchestrationChildren: latestOrchestration };
          } else if (pending !== null) {
            pendingFullRef.current = null; // stale pending superseded by the seed
          } else if (current.orchestrationChildren !== latestOrchestration) {
            next = { ...current, orchestrationChildren: latestOrchestration };
          }
          // Replay any pre-seed state-deltas in order; a delta that is NOT
          // newer than the already-applied state is stale (its changes are
          // already inside a buffered full published later) and must skip —
          // the pure applyStateDelta has no revision guard of its own.
          if (pendingDeltaRef.current.length > 0) {
            const buffered = pendingDeltaRef.current;
            pendingDeltaRef.current = [];
            for (const payload of buffered) {
              if (payload.revision <= next.revision) {
                continue;
              }
              next = applyStateDelta(next, payload.ops);
            }
          }
          return next === current ? current : next;
        });
        return;
      }
      // Cardo: pushed full state (state-changed) arrives orchestration-stripped
      // (T2): complete it from the local ref under the same revision guard.
      setSnapshotWithOrchestration((current) => {
        if (current && incoming.revision < current.revision) {
          return current;
        }
        if (pendingFullRef.current !== null && incoming.revision >= pendingFullRef.current.revision) {
          pendingFullRef.current = null; // applied or superseded — no longer needed
        }
        if (!hasFullStateRef.current) {
          // No full DesktopAppState has arrived yet (the in-flight getState()
          // response seeds it) — buffer the latest pushed full instead of
          // dropping it, so a stale seed cannot strand the renderer (above).
          pendingFullRef.current = incoming;
          return current;
        }
        if (!current) {
          // Defensive: the flag is only set when a full flowed through and
          // set the snapshot, so this cannot happen — but never merge into null.
          pendingFullRef.current = incoming;
          return current;
        }
        return { ...incoming, orchestrationChildren: orchestrationRef.current ?? current.orchestrationChildren };
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
        if (!current || !hasFullStateRef.current) {
          // Cardo: pre-seed delta — buffer it (relative to the buffered
          // full's state); replayed by the seed drain so it is never lost.
          pendingDeltaRef.current.push(payload);
          return current;
        }
        if (payload.revision <= current.revision) {
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
