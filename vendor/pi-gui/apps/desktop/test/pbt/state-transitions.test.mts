/**
 * Cardo PBT: state-transition invariants for the app-store session-state layer.
 *
 * Locks down:
 *  - applySessionEventState: revision, workspace/session scoping, status transitions,
 *    snapshot application, map-driven fields, hasUnseenUpdate consistency.
 *  - updateSessionRecord: field-merge precedence (explicit option > snapshot > prior),
 *    map-driven fields, hasUnseenUpdate consistency, input immutability.
 *
 * Note on runningSince/lastViewedAt: in the app these are ALWAYS driven by the
 * by-session maps (both call sites pass map values; clearRunState deletes the map
 * entries BEFORE applySessionEventState runs, so an undefined option value MUST
 * clear the record — "keep prior" would leave a stale runningSince after
 * runCompleted). The tests therefore assert the map value is authoritative
 * (undefined clears).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  applySessionEventState,
  updateSessionRecord,
} from "../../out-pbt/desktop/electron/app-store-session-state.js";
import {
  cloneTranscriptMessage,
  hasUnseenSessionUpdate,
  previewFromTranscript,
} from "../../out-pbt/desktop/electron/app-store-utils.js";
import {
  arbDesktopAppState,
  arbEventRefForState,
  arbIsoTimestamp,
  arbOptionalString,
  arbSessionDriverEvent,
  arbSessionRecord,
  arbTranscript,
  arbTranscriptCache,
  keyOf,
  deepEqual,
} from "./arbitraries.mts";
import type { SessionDriverEvent, SessionRef, SessionStatus } from "../../../../packages/session-driver/dist/index.js";
import type { SessionRecord } from "../../out-pbt/desktop/src/desktop-state.js";

const NUM_RUNS = 150;

/* ── reference spec for statusForEvent (documented business rule) ── */

function expectedStatusForEvent(priorStatus: SessionRecord["status"], event: SessionDriverEvent): SessionRecord["status"] {
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
      return priorStatus;
  }
}

const SNAPSHOT_EVENT_TYPES = new Set(["sessionOpened", "sessionUpdated", "runCompleted"]);

/* ── minimal structural state shape used by the properties ── */

interface RawWorkspace {
  readonly id: string;
  readonly sessions: readonly { readonly id: string }[];
}

interface RawState {
  readonly workspaces: readonly RawWorkspace[];
  readonly revision: number;
}

interface SnapshotEventShape {
  readonly snapshot?: {
    readonly title?: string;
    readonly updatedAt?: string;
    readonly archivedAt?: string;
    readonly preview?: string;
    readonly status?: SessionRecord["status"];
    readonly config?: unknown;
  };
}

/* ── shared state+event generator: biases the event ref toward the state's sessions ── */

function arbStateAndEvent(): fc.Arbitrary<{ state: RawState; event: SessionDriverEvent }> {
  return arbDesktopAppState().chain((state) => {
    const typedState = state as unknown as RawState;
    return fc.record({
      state: fc.constant(typedState),
      event: arbSessionDriverEvent(arbEventRefForState(typedState)),
    });
  });
}

function findTargetSession(state: RawState, ref: SessionRef): { readonly id: string } | undefined {
  const workspace = state.workspaces.find((w) => w.id === ref.workspaceId);
  return workspace?.sessions.find((s) => s.id === ref.sessionId);
}

function applyEvent(
  state: RawState,
  event: SessionDriverEvent,
  transcriptCache: Map<string, unknown[]>,
  runningSinceBySession: Map<string, string>,
  lastViewedAtBySession: Map<string, string>,
): RawState {
  return applySessionEventState(
    state as never,
    event,
    transcriptCache as never,
    runningSinceBySession as never,
    lastViewedAtBySession as never,
  ) as unknown as RawState;
}

/* ── applySessionEventState ─────────────────────────────── */

test("applySessionEventState: revision increments by exactly 1; input state is not mutated", () => {
  fc.assert(
    fc.property(
      arbStateAndEvent(),
      arbTranscriptCache(),
      arbitraryStringMap(),
      arbitraryStringMap(),
      ({ state, event }, transcriptCache, runningSinceBySession, lastViewedAtBySession) => {
        const before = structuredClone(state);
        const result = applyEvent(state, event, transcriptCache, runningSinceBySession, lastViewedAtBySession);

        assert.equal(result.revision, state.revision + 1);
        assert.notEqual(result, state);
        assert.notEqual(result.workspaces, state.workspaces);
        assert.ok(deepEqual(state, before));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applySessionEventState: non-target workspaces and non-target sessions are reference-identical", () => {
  fc.assert(
    fc.property(
      arbStateAndEvent(),
      arbTranscriptCache(),
      arbitraryStringMap(),
      arbitraryStringMap(),
      ({ state, event }, transcriptCache, runningSinceBySession, lastViewedAtBySession) => {
        const result = applyEvent(state, event, transcriptCache, runningSinceBySession, lastViewedAtBySession);

        state.workspaces.forEach((workspace, index) => {
          if (workspace.id === event.sessionRef.workspaceId) {
            workspace.sessions.forEach((session, sessionIndex) => {
              if (session.id !== event.sessionRef.sessionId) {
                assert.equal(
                  (result.workspaces[index] as { sessions: readonly unknown[] }).sessions[sessionIndex],
                  session,
                );
              }
            });
          } else {
            assert.equal(result.workspaces[index], workspace);
          }
        });
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applySessionEventState: unknown workspace/session leaves all workspaces deep-equal (only revision changes)", () => {
  fc.assert(
    fc.property(
      arbStateAndEvent(),
      arbTranscriptCache(),
      arbitraryStringMap(),
      arbitraryStringMap(),
      ({ state, event }, transcriptCache, runningSinceBySession, lastViewedAtBySession) => {
        const matches = state.workspaces.some(
          (w) => w.id === event.sessionRef.workspaceId && w.sessions.some((s) => s.id === event.sessionRef.sessionId),
        );
        fc.pre(!matches);

        const result = applyEvent(state, event, transcriptCache, runningSinceBySession, lastViewedAtBySession);

        assert.equal(result.workspaces.length, state.workspaces.length);
        state.workspaces.forEach((workspace, index) => {
          assert.ok(deepEqual(result.workspaces[index], workspace));
        });
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applySessionEventState: status transitions follow statusForEvent rules", () => {
  fc.assert(
    fc.property(
      arbStateAndEvent(),
      arbTranscriptCache(),
      arbitraryStringMap(),
      arbitraryStringMap(),
      ({ state, event }, transcriptCache, runningSinceBySession, lastViewedAtBySession) => {
        const target = findTargetSession(state, event.sessionRef);
        if (!target) {
          return;
        }
        const result = applyEvent(state, event, transcriptCache, runningSinceBySession, lastViewedAtBySession);
        const updated = findTargetSession(result, event.sessionRef);
        assert.ok(updated, "target session must still exist after applying the event");
        assert.equal(
          (updated as unknown as { status: SessionRecord["status"] }).status,
          expectedStatusForEvent((target as unknown as { status: SessionRecord["status"] }).status, event),
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applySessionEventState: snapshot fields apply only for sessionOpened/sessionUpdated/runCompleted", () => {
  fc.assert(
    fc.property(
      arbStateAndEvent(),
      arbTranscriptCache(),
      arbitraryStringMap(),
      arbitraryStringMap(),
      ({ state, event }, transcriptCache, runningSinceBySession, lastViewedAtBySession) => {
        const target = findTargetSession(state, event.sessionRef);
        if (!target) {
          return;
        }
        const key = keyOf(event.sessionRef);
        const transcript = (transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);
        const snapshot = SNAPSHOT_EVENT_TYPES.has(event.type)
          ? (event as SessionDriverEvent & SnapshotEventShape).snapshot
          : undefined;

        const result = applyEvent(state, event, transcriptCache, runningSinceBySession, lastViewedAtBySession);
        const updated = findTargetSession(result, event.sessionRef)! as unknown as {
          title: string;
          updatedAt: string;
          archivedAt?: string;
          config?: unknown;
          preview: string;
        };
        const prior = target as unknown as {
          title: string;
          updatedAt: string;
          archivedAt?: string;
          config?: unknown;
          preview: string;
        };

        assert.equal(updated.title, snapshot?.title ?? prior.title);
        assert.equal(updated.updatedAt, snapshot?.updatedAt ?? prior.updatedAt);
        assert.equal(updated.archivedAt, snapshot?.archivedAt ?? prior.archivedAt);
        assert.equal(updated.config, snapshot?.config ?? prior.config);
        assert.equal(updated.preview, previewFromTranscript(transcript) ?? snapshot?.preview ?? prior.preview);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applySessionEventState: runningSince/lastViewedAt mirror the maps; hasUnseenUpdate consistent with the record", () => {
  fc.assert(
    fc.property(
      arbStateAndEvent(),
      arbTranscriptCache(),
      arbitraryStringMap(),
      arbitraryStringMap(),
      ({ state, event }, transcriptCache, runningSinceBySession, lastViewedAtBySession) => {
        const target = findTargetSession(state, event.sessionRef);
        if (!target) {
          return;
        }
        const key = keyOf(event.sessionRef);
        const transcript = (transcriptCache.get(key) ?? []).map(cloneTranscriptMessage);

        const result = applyEvent(state, event, transcriptCache, runningSinceBySession, lastViewedAtBySession);
        const updated = findTargetSession(result, event.sessionRef)! as unknown as {
          runningSince?: string;
          lastViewedAt?: string;
          status: SessionRecord["status"];
          updatedAt: string;
          hasUnseenUpdate: boolean;
        };

        assert.equal(updated.runningSince, runningSinceBySession.get(key));
        assert.equal(updated.lastViewedAt, lastViewedAtBySession.get(key));
        assert.equal(
          updated.hasUnseenUpdate,
          hasUnseenSessionUpdate(updated.status, updated.updatedAt, updated.lastViewedAt, transcript),
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

/* ── updateSessionRecord ────────────────────────────────── */

function arbSnapshotPartial(): fc.Arbitrary<{
  title?: string;
  updatedAt?: string;
  archivedAt?: string;
  preview?: string;
  status?: SessionStatus;
  config?: unknown;
}> {
  return fc.record({
    title: arbOptionalString(),
    updatedAt: arbOptionalString(),
    archivedAt: arbOptionalString(),
    preview: arbOptionalString(),
    status: fc.option(fc.constantFrom("idle", "running", "failed"), { nil: undefined }),
    config: fc.option(fc.record({ provider: fc.string(), modelId: fc.string() }), { nil: undefined }),
  });
}

interface SessionRecordShape {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly lastViewedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: SessionRecord["status"];
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly config?: unknown;
}

test("updateSessionRecord: explicit option > snapshot > prior precedence; map-driven fields authoritative", () => {
  fc.assert(
    fc.property(
      arbSessionRecord(),
      arbSnapshotPartial(),
      fc.option(fc.constantFrom("idle", "running", "failed") as fc.Arbitrary<SessionStatus>, { nil: undefined }),
      arbTranscript(),
      arbOptionalString(),
      arbOptionalString(),
      arbOptionalString(),
      (prior, snapshot, status, transcript, preview, runningSince, lastViewedAt) => {
        const before = structuredClone(prior);
        const priorRecord = prior as unknown as SessionRecordShape;
        const result = updateSessionRecord(prior as never, {
          snapshot: snapshot as never,
          status,
          transcript: transcript as never,
          preview,
          runningSince,
          lastViewedAt,
        }) as unknown as SessionRecordShape;

        assert.equal(result.title, snapshot?.title ?? priorRecord.title);
        assert.equal(result.updatedAt, snapshot?.updatedAt ?? priorRecord.updatedAt);
        assert.equal(result.archivedAt, snapshot?.archivedAt ?? priorRecord.archivedAt);
        assert.equal(result.preview, preview ?? snapshot?.preview ?? priorRecord.preview);
        assert.equal(result.status, status ?? snapshot?.status ?? priorRecord.status);
        assert.equal(result.config, snapshot?.config ?? priorRecord.config);

        // Map-driven fields: the explicit option is authoritative (undefined clears —
        // required so runCompleted/sessionClosed clear a stale runningSince).
        assert.equal(result.lastViewedAt, lastViewedAt);
        assert.equal(result.runningSince, runningSince);

        // Non-merged fields carried over; input never mutated.
        assert.equal(result.id, priorRecord.id);
        assert.equal(result.pinnedAt, priorRecord.pinnedAt);
        assert.ok(deepEqual(prior, before));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("updateSessionRecord: hasUnseenUpdate is consistent with the resulting record fields", () => {
  fc.assert(
    fc.property(
      arbSessionRecord(),
      arbSnapshotPartial(),
      fc.option(fc.constantFrom("idle", "running", "failed") as fc.Arbitrary<SessionStatus>, { nil: undefined }),
      arbTranscript(),
      arbOptionalString(),
      arbOptionalString(),
      arbOptionalString(),
      (prior, snapshot, status, transcript, preview, runningSince, lastViewedAt) => {
        const result = updateSessionRecord(prior as never, {
          snapshot: snapshot as never,
          status,
          transcript: transcript as never,
          preview,
          runningSince,
          lastViewedAt,
        }) as unknown as SessionRecordShape;
        assert.equal(
          result.hasUnseenUpdate,
          hasUnseenSessionUpdate(result.status, result.updatedAt, result.lastViewedAt, transcript as never),
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

/* ── local helpers ──────────────────────────────────────── */

function arbitraryStringMap(): fc.Arbitrary<Map<string, string>> {
  return fc
    .array(fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), arbIsoTimestamp()), { maxLength: 4 })
    .map((pairs) => new Map(pairs));
}
