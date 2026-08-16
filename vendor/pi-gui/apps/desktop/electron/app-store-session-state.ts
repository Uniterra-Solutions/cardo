import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionSnapshot } from "@pi-gui/session-driver";
import type { DesktopAppState, SessionRecord, TranscriptMessage } from "../src/desktop-state";
import { hasUnseenSessionUpdate, previewFromTranscript } from "./app-store-utils";
// Cardo: T1 — the cache value is the persistent chunked entry; the fold consumes
// it read-only (the entry is structurally assignable to readonly TranscriptMessage[]).
import type { TranscriptCacheEntry } from "./app-store-timeline";

export function applySessionEventState(
  state: DesktopAppState,
  event: SessionDriverEvent,
  transcriptCache: ReadonlyMap<string, TranscriptCacheEntry>,
  runningSinceBySession: Map<string, string>,
  lastViewedAtBySession: Map<string, string>,
): DesktopAppState {
  const key = sessionKey(event.sessionRef);
  // Cardo: stream-liveness — never re-copy the accumulated transcript per
  // event. The previous `(cache ?? []).map(cloneTranscriptMessage)` pass deep-
  // cloned the WHOLE transcript on every driver event, feeding only read-only
  // computations (previewFromTranscript, hasUnseenSessionUpdate /
  // latestSessionActivityAt). Cache arrays are rebuilt on mutation (never
  // mutated in place), so read-only access is safe; SessionRecord carries no
  // transcript. Folding one event is now O(1) in transcript length instead of
  // O(accumulated items) — the quadratic main-process work that saturated on
  // long tasks (locked by test/pbt/store-liveness.test.mts invariant K).
  const transcript = transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript);
  const lastViewedAt = lastViewedAtBySession.get(key);

  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === event.sessionRef.workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === event.sessionRef.sessionId
                ? updateSessionRecord(session, {
                    snapshot: snapshotForEvent(event),
                    status: statusForEvent(session.status, event),
                    transcript,
                    preview,
                    runningSince: runningSinceBySession.get(key),
                    lastViewedAt,
                  })
                : session,
            ),
          }
        : workspace,
    ),
    revision: state.revision + 1,
  };
}

export function updateSessionRecord(
  session: SessionRecord,
  options: {
    readonly snapshot?: Partial<
      Pick<SessionSnapshot, "title" | "updatedAt" | "archivedAt" | "preview" | "status" | "config">
    >;
    readonly status?: SessionRecord["status"];
    readonly transcript: readonly TranscriptMessage[];
    readonly preview: string | undefined;
    readonly runningSince: string | undefined;
    readonly lastViewedAt: string | undefined;
  },
): SessionRecord {
  const updatedAt = options.snapshot?.updatedAt ?? session.updatedAt;
  const nextStatus = options.status ?? options.snapshot?.status ?? session.status;
  return {
    ...session,
    title: options.snapshot?.title ?? session.title,
    updatedAt,
    lastViewedAt: options.lastViewedAt,
    archivedAt: options.snapshot?.archivedAt ?? session.archivedAt,
    preview: options.preview ?? options.snapshot?.preview ?? session.preview,
    status: nextStatus,
    runningSince: options.runningSince,
    hasUnseenUpdate: hasUnseenSessionUpdate(nextStatus, updatedAt, options.lastViewedAt, options.transcript),
    config: options.snapshot?.config ?? session.config,
  };
}

function snapshotForEvent(event: SessionDriverEvent) {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      return event.snapshot;
    default:
      return undefined;
  }
}

function statusForEvent(sessionStatus: SessionRecord["status"], event: SessionDriverEvent): SessionRecord["status"] {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      return event.snapshot.status;
    case "runFailed":
      return "failed";
    case "sessionClosed":
      return "idle";
    default:
      return sessionStatus;
  }
}
