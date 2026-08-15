import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, SelectedTranscriptRecord } from "../desktop-state";
import { applyTranscriptDelta } from "../transcript-delta";

export function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<SelectedTranscriptRecord | null>(null);

  useEffect(() => {
    let active = true;
    let receivedPushedTranscript = false;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    // The initial getState() can resolve after an early pushed state-changed event; never let a
    // snapshot with a lower revision overwrite a newer one already applied to state.
    const applyState = (incoming: DesktopAppState) => {
      applySnapshotIfNewer(setSnapshot, incoming);
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

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeTranscript();
      unsubscribeTranscriptDelta();
    };
  }, []);

  return [snapshot, setSnapshot, selectedTranscript] as const;
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
