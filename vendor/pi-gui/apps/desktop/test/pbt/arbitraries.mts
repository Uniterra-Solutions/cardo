/**
 * Cardo PBT: shared fast-check arbitraries for the app-store state-transformation layer.
 *
 * Test files import the COMPILED modules from out-pbt/ (see tsconfig.pbt.json), not source.
 * These generators produce plain JSON-compatible objects that match the runtime shapes the
 * app-store functions actually read (SessionDriverEvent, SessionSnapshot, SessionQueuedMessage,
 * SessionTranscriptItem, catalog entries, DesktopAppState, TranscriptMessage).
 */
import * as fc from "fast-check";
import type {
  SessionDriverEvent,
  SessionQueuedMessage,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
} from "../../../../packages/session-driver/dist/index.js";
import type { SessionTranscriptItem } from "../../../../packages/pi-sdk-driver/dist/index.js";
import type { TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";
import type { SessionStatus as DesktopSessionStatus } from "../../out-pbt/desktop/src/desktop-state.js";
import type {
  SessionCatalogEntry,
  WorktreeCatalogEntry,
  WorkspaceCatalogEntry,
} from "../../../../packages/catalogs/dist/index.js";
import { sessionKey } from "../../../../packages/pi-sdk-driver/dist/index.js";

/* ── primitives ─────────────────────────────────────────── */

export const arbIsoTimestamp = (): fc.Arbitrary<string> =>
  // noInvalidDate: true — fast-check's default date generator deliberately emits
  // invalid (NaN) dates; the app-store layer expects well-formed ISO timestamps.
  fc
    .date(
      { min: new Date("2020-01-01T00:00:00.000Z"), max: new Date("2030-12-31T23:59:59.999Z"), noInvalidDate: true },
    )
    .map((d) => d.toISOString());

export const arbSessionRef = (): fc.Arbitrary<SessionRef> =>
  fc.record({
    workspaceId: fc.string({ minLength: 1, maxLength: 12 }),
    sessionId: fc.string({ minLength: 1, maxLength: 12 }),
  });

export const arbSessionStatus = (): fc.Arbitrary<SessionStatus> =>
  fc.constantFrom("idle", "running", "failed");

export const arbOptionalString = (): fc.Arbitrary<string | undefined> =>
  fc.option(fc.string({ minLength: 0, maxLength: 40 }), { nil: undefined });

/** Arbitrary JSON-ish unknown payloads (tool inputs/outputs, error details). */
export const arbUnknown = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.string({ minLength: 0, maxLength: 60 }),
    fc.integer(),
    fc.boolean(),
    fc.record({ error: fc.string(), message: fc.string(), content: fc.array(fc.record({ type: fc.constant("text"), text: fc.string() })) }),
    fc.array(fc.string(), { maxLength: 4 }),
  );

/* ── transcripts ────────────────────────────────────────── */

export const arbTranscriptMessageItem = (): fc.Arbitrary<TranscriptMessage> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("message" as const),
      id: fc.uuid(),
      role: fc.constantFrom("user", "assistant", "branchSummary", "compactionSummary"),
      text: fc.string({ minLength: 0, maxLength: 80 }),
      createdAt: arbIsoTimestamp(),
    }),
    fc.record({
      kind: fc.constant("activity" as const),
      id: fc.uuid(),
      createdAt: arbIsoTimestamp(),
      label: fc.string({ minLength: 0, maxLength: 60 }),
      tone: fc.constantFrom("neutral" as const, "success", "warning", "error"),
    }),
    fc.record({
      kind: fc.constant("tool" as const),
      id: fc.uuid(),
      callId: fc.uuid(),
      toolName: fc.string({ minLength: 1, maxLength: 20 }),
      status: fc.constantFrom("running" as const, "success", "error"),
      label: fc.string({ minLength: 0, maxLength: 60 }),
      createdAt: arbIsoTimestamp(),
    }),
    fc.record({
      kind: fc.constant("summary" as const),
      id: fc.uuid(),
      createdAt: arbIsoTimestamp(),
      label: fc.string({ minLength: 0, maxLength: 60 }),
      presentation: fc.constantFrom("inline" as const, "divider"),
    }),
  );

export const arbTranscript = (): fc.Arbitrary<TranscriptMessage[]> =>
  fc.array(arbTranscriptMessageItem(), { maxLength: 6 });

export const arbTranscriptCache = (): fc.Arbitrary<Map<string, TranscriptMessage[]>> =>
  fc
    .array(fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), arbTranscript()), { maxLength: 4 })
    .map((pairs) => new Map(pairs));

/* ── driver transcript items (input to timelineFromDriverTranscript) ── */

export const arbDriverTranscriptItem = (): fc.Arbitrary<SessionTranscriptItem> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("message" as const),
      id: fc.uuid(),
      role: fc.constantFrom("user", "assistant", "branchSummary", "compactionSummary"),
      text: fc.string({ minLength: 0, maxLength: 80 }),
      createdAt: arbIsoTimestamp(),
    }),
    fc.record({
      kind: fc.constant("tool" as const),
      id: fc.uuid(),
      callId: fc.uuid(),
      toolName: fc.string({ minLength: 1, maxLength: 20 }),
      status: fc.constantFrom("success" as const, "error"),
      createdAt: arbIsoTimestamp(),
      input: arbUnknown(),
      output: arbUnknown(),
    }),
  );

/* ── session records / desktop state ────────────────────── */

export const arbSessionRecord = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    title: fc.string({ minLength: 0, maxLength: 40 }),
    updatedAt: arbIsoTimestamp(),
    pinnedAt: arbOptionalString(),
    lastViewedAt: arbOptionalString(),
    archivedAt: arbOptionalString(),
    preview: fc.string({ minLength: 0, maxLength: 60 }),
    status: fc.constantFrom("idle", "running", "failed"),
    runningSince: arbOptionalString(),
    hasUnseenUpdate: fc.boolean(),
    config: fc.option(fc.record({ provider: fc.string(), modelId: fc.string() }), { nil: undefined }),
  });

export const arbWorkspaceRecord = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    name: fc.string({ minLength: 0, maxLength: 40 }),
    path: fc.string({ minLength: 1, maxLength: 40 }),
    lastOpenedAt: arbIsoTimestamp(),
    kind: fc.constantFrom("primary", "worktree"),
    sessions: fc.array(arbSessionRecord(), { maxLength: 3 }),
  });

/** A minimal valid DesktopAppState with arbitrary workspaces (other state fields untouched). */
export const arbDesktopAppState = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.record({
    workspaces: fc.array(arbWorkspaceRecord(), { maxLength: 3 }),
    revision: fc.integer({ min: 0, max: 100_000 }),
  });

/* ── session driver events ──────────────────────────────── */

export const arbSessionSnapshot = (): fc.Arbitrary<SessionSnapshot> =>
  fc.record({
    ref: arbSessionRef(),
    workspace: fc.record({ workspaceId: fc.string(), path: fc.string() }),
    title: fc.string({ minLength: 0, maxLength: 40 }),
    status: arbSessionStatus(),
    updatedAt: arbIsoTimestamp(),
    archivedAt: arbOptionalString(),
    preview: arbOptionalString(),
    config: fc.option(fc.record({ provider: fc.string(), modelId: fc.string() }), { nil: undefined }),
    runningRunId: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  });

export const arbQueuedMessage = (): fc.Arbitrary<SessionQueuedMessage> =>
  fc.record({
    id: fc.uuid(),
    mode: fc.constantFrom("steer", "followUp"),
    text: fc.string({ minLength: 0, maxLength: 80 }),
    attachments: fc.option(
      fc.array(fc.record({ kind: fc.constant("file" as const), name: fc.string(), mimeType: fc.string(), fsPath: fc.string() }), {
        maxLength: 2,
      }),
      { nil: undefined },
    ),
    createdAt: arbIsoTimestamp(),
    updatedAt: arbIsoTimestamp(),
  });

/**
 * Arbitrary SessionDriverEvent targeting the given sessionRef arbitrary. Every event
 * type is produced; fields are populated with the shapes each app-store handler reads.
 */
export const arbSessionDriverEvent = (refArb: fc.Arbitrary<SessionRef>): fc.Arbitrary<SessionDriverEvent> =>
  fc.oneof(
    fc.record({
      type: fc.constant("sessionOpened" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      snapshot: arbSessionSnapshot(),
    }),
    fc.record({
      type: fc.constant("sessionUpdated" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      snapshot: arbSessionSnapshot(),
    }),
    fc.record({
      type: fc.constant("assistantDelta" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      text: fc.string({ minLength: 0, maxLength: 60 }),
    }),
    fc.record({
      type: fc.constant("queuedMessageStarted" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      message: arbQueuedMessage(),
    }),
    fc.record({
      type: fc.constant("toolStarted" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      toolName: fc.string({ minLength: 1, maxLength: 20 }),
      callId: fc.uuid(),
      input: arbUnknown(),
    }),
    fc.record({
      type: fc.constant("toolUpdated" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      callId: fc.uuid(),
      text: arbOptionalString(),
      progress: fc.option(fc.float({ min: 0, max: 10, noNaN: true }), { nil: undefined }),
    }),
    fc.record({
      type: fc.constant("toolFinished" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      callId: fc.uuid(),
      success: fc.boolean(),
      output: arbUnknown(),
    }),
    fc.record({
      type: fc.constant("runCompleted" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      snapshot: arbSessionSnapshot(),
    }),
    fc.record({
      type: fc.constant("runFailed" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      error: fc.record({
        message: fc.string({ minLength: 0, maxLength: 60 }),
        code: arbOptionalString(),
        details: arbUnknown(),
      }),
    }),
    fc.record({
      type: fc.constant("hostUiRequest" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      request: fc.oneof(
        fc.record({ kind: fc.constant("notify" as const), requestId: fc.uuid(), message: fc.string({ minLength: 0, maxLength: 60 }) }),
        fc.record({ kind: fc.constant("status" as const), requestId: fc.uuid(), key: fc.string() }),
        fc.record({ kind: fc.constant("title" as const), requestId: fc.uuid(), title: fc.string() }),
      ),
    }),
    fc.record({
      type: fc.constant("extensionCompatibilityIssue" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      issue: fc.record({
        capability: fc.string(),
        classification: fc.constant("terminal-only" as const),
        message: fc.string(),
        extensionPath: arbOptionalString(),
        eventName: arbOptionalString(),
      }),
    }),
    fc.record({
      type: fc.constant("sessionClosed" as const),
      sessionRef: refArb,
      timestamp: arbIsoTimestamp(),
      runId: fc.option(fc.string(), { nil: undefined }),
      reason: fc.constantFrom("manual", "ended", "failed"),
    }),
  );

/** Pick a sessionRef from the state's existing sessions when possible, else an arbitrary one. */
export const arbEventRefForState = (state: { workspaces: readonly { id: string; sessions: readonly { id: string }[] }[] }): fc.Arbitrary<SessionRef> => {
  const pairs = state.workspaces.flatMap((workspace) =>
    workspace.sessions.map((session) => ({ workspaceId: workspace.id, sessionId: session.id })),
  );
  const randomRef = arbSessionRef();
  if (pairs.length === 0) {
    return randomRef;
  }
  return fc.oneof(fc.constantFrom(...pairs), randomRef, randomRef);
};

/* ── catalog entries (buildWorkspaceRecords inputs) ─────── */

export const arbWorkspaceCatalogEntry = (): fc.Arbitrary<WorkspaceCatalogEntry> =>
  fc.record({
    workspaceId: fc.string({ minLength: 1, maxLength: 12 }),
    path: fc.string({ minLength: 1, maxLength: 40 }),
    displayName: fc.string({ minLength: 0, maxLength: 40 }),
    lastOpenedAt: arbIsoTimestamp(),
    sortOrder: fc.integer({ min: 0, max: 1000 }),
    pinned: fc.option(fc.boolean(), { nil: undefined }),
  });

export const arbWorktreeCatalogEntry = (): fc.Arbitrary<WorktreeCatalogEntry> =>
  fc.record({
    worktreeId: fc.string({ minLength: 1, maxLength: 20 }),
    workspaceId: fc.string({ minLength: 1, maxLength: 12 }),
    path: fc.string({ minLength: 1, maxLength: 40 }),
    displayName: fc.string({ minLength: 0, maxLength: 40 }),
    kind: fc.constantFrom("primary", "linked"),
    status: fc.constantFrom("ready", "missing", "error"),
    branchName: arbOptionalString(),
    headSha: arbOptionalString(),
    pinned: fc.option(fc.boolean(), { nil: undefined }),
    createdAt: arbIsoTimestamp(),
    updatedAt: arbIsoTimestamp(),
  });

export const arbSessionCatalogEntry = (): fc.Arbitrary<SessionCatalogEntry> =>
  fc.record({
    sessionRef: arbSessionRef(),
    workspaceId: fc.string({ minLength: 1, maxLength: 12 }),
    title: fc.string({ minLength: 0, maxLength: 40 }),
    updatedAt: arbIsoTimestamp(),
    archivedAt: arbOptionalString(),
    previewSnippet: arbOptionalString(),
    sessionFilePath: arbOptionalString(),
    status: fc.constantFrom("idle", "running", "failed"),
  });

/* ── helpers ────────────────────────────────────────────── */

export const keyOf = (ref: SessionRef): string => sessionKey(ref);

export type DesktopStatus = DesktopSessionStatus;

/** Recursively deep-equal two unknown values (assert.deepEqual is not importable here). */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftKeys = Object.keys(left as Record<string, unknown>).sort();
    const rightKeys = Object.keys(right as Record<string, unknown>).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(
      (key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }
  return false;
}
