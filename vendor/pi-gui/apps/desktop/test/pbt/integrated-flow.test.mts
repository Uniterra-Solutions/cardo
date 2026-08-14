/**
 * Integrated end-to-end state-machine property tests for the pi-gui desktop
 * app-store event flow:
 *
 *   driver events → (appendAssistantDelta / applyTimelineEvent → transcriptCache)
 *                 → applySessionEventState → DesktopAppState
 *
 * This mirrors the real main-process wiring in electron/app-store.ts:
 *   - assistantDelta events are folded into the active assistant message via
 *     appendAssistantDelta BEFORE applyTimelineEvent (which skips deltas), and
 *   - applyTimelineEvent mutates the shared transcriptCache /
 *     runningSinceBySession maps, which applySessionEventState then reads.
 *
 * Modules exercised (compiled from tsconfig.pbt.json into out-pbt/):
 *   electron/app-store-timeline.ts, electron/app-store-session-state.ts,
 *   electron/app-store-utils.ts, src/desktop-state.ts
 *
 * Invariants under test:
 *  1. Arbitrary event sequences: revision increments by exactly 1 per event;
 *     the target workspace/session always exists; session status / runningSince
 *     follow the event semantics; the transcriptCache is a prefix-consistent
 *     accumulation where each event's effect is reflected (assistantDelta
 *     appends to the active assistant message, tool rows upsert by callId,
 *     user messages upsert by id, activity/summary counters accumulate); no
 *     event throws.
 *  2. Order independence for genuinely commuting events (assistantDelta +
 *     sessionUpdated(idle), toolStarted + toolUpdated, distinct
 *     queuedMessageStarted), with a contrast property proving toolStarted +
 *     toolFinished do NOT commute.
 *  3. Restart/replay: replaying the same sequence with fresh caches yields the
 *     identical transcript content (modulo random ids/timestamps) and session
 *     record.
 *  4. Full flow: arbitrary workspace/session catalogs → buildWorkspaceRecords →
 *     arbitrary events for one session → final DesktopAppState selection
 *     remains valid, revision advanced by exactly the event count, and every
 *     session preview is derived from its transcript when the transcript
 *     yields one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionQueuedMessage, SessionRef, SessionSnapshot } from "@pi-gui/session-driver";

// Structural stand-ins for the catalog entry shapes (type-only; the catalogs
// package is not resolvable from the desktop app at runtime, and these types
// are erased before execution anyway).
interface WorkspaceCatalogEntry {
  workspaceId: string;
  path: string;
  displayName: string;
  lastOpenedAt: string;
  sortOrder: number;
  pinned?: boolean;
}

interface SessionCatalogEntry {
  sessionRef: SessionRef;
  workspaceId: string;
  title: string;
  updatedAt: string;
  archivedAt?: string;
  previewSnippet?: string;
  status: "idle" | "running" | "failed";
}

import { applySessionEventState } from "../../out-pbt/desktop/electron/app-store-session-state.js";
import { applyTimelineEvent, appendAssistantDelta, appendThinkingDelta, finalizeActiveThinking } from "../../out-pbt/desktop/electron/app-store-timeline.js";
import { buildWorkspaceRecords, previewFromTranscript } from "../../out-pbt/desktop/electron/app-store-utils.js";
import { createEmptyDesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import type { DesktopAppState, SessionRecord, TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";

// ---------------------------------------------------------------------------
// fixed target session for the state-machine properties
// ---------------------------------------------------------------------------

const TARGET_WORKSPACE_ID = "pbt-ws-1";
const TARGET_SESSION_ID = "pbt-session-1";
const TARGET_SESSION_REF: SessionRef = {
  workspaceId: TARGET_WORKSPACE_ID,
  sessionId: TARGET_SESSION_ID,
};

// NOTE: never use fc.date().map((d) => d.toISOString()) — fast-check can emit
// NaN dates, which makes toISOString throw `Invalid time value` at generation
// time. Generating epoch milliseconds keeps every timestamp parseable.
const tsArb = fc
  .integer({
    min: Date.parse("2026-01-01T00:00:00.000Z"),
    max: Date.parse("2026-12-31T23:59:59.999Z"),
  })
  .map((ms) => new Date(ms).toISOString());

// ---------------------------------------------------------------------------
// caches + the real flow driver
// ---------------------------------------------------------------------------

interface FlowCaches {
  transcriptCache: Map<string, TranscriptMessage[]>;
  runningSinceBySession: Map<string, string>;
  lastViewedAtBySession: Map<string, string>;
  activeAssistantMessageBySession: Map<string, string>;
  activeWorkingActivityBySession: Map<string, string>;
  activeThinkingBySession: Map<string, { id: string; text: string; startedAt: string }>;
  runMetricsBySession: Map<string, {
    startedAt: string;
    toolCount: number;
    searchCount: number;
    fileCount: number;
  }>;
}

function freshCaches(): FlowCaches {
  return {
    transcriptCache: new Map(),
    runningSinceBySession: new Map(),
    lastViewedAtBySession: new Map(),
    activeAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    activeThinkingBySession: new Map(),
    runMetricsBySession: new Map(),
  };
}

/** Mirrors electron/app-store.ts handleDriverEvent ordering. */
function driveEvent(caches: FlowCaches, event: SessionDriverEvent): void {
  if (event.type === "assistantDelta") {
    finalizeActiveThinking(
      caches.transcriptCache,
      caches.activeThinkingBySession,
      event.sessionRef,
    );
    appendAssistantDelta(
      caches.transcriptCache,
      caches.activeAssistantMessageBySession,
      event.sessionRef,
      event.text,
    );
  } else if (event.type === "assistantThinkingDelta") {
    appendThinkingDelta(
      caches.transcriptCache,
      caches.activeThinkingBySession,
      event.sessionRef,
      event.text,
    );
  }
  applyTimelineEvent(caches.transcriptCache, event, {
    runMetricsBySession: caches.runMetricsBySession,
    runningSinceBySession: caches.runningSinceBySession,
    activeAssistantMessageBySession: caches.activeAssistantMessageBySession,
    activeWorkingActivityBySession: caches.activeWorkingActivityBySession,
    activeThinkingBySession: caches.activeThinkingBySession,
  });
}

// ---------------------------------------------------------------------------
// shadow model encoding the SPEC (not the implementation) of event semantics
// ---------------------------------------------------------------------------

type ShadowStatus = "idle" | "running" | "failed";

interface Shadow {
  status: ShadowStatus;
  runningSince: string | undefined;
  activeAssistantText: string | undefined;
  counts: {
    sessionOpened: number;
    runCompleted: number;
    runFailed: number;
    sessionClosed: number;
    hostNotify: number;
  };
}

function freshShadow(): Shadow {
  return {
    status: "idle",
    runningSince: undefined,
    activeAssistantText: undefined,
    counts: { sessionOpened: 0, runCompleted: 0, runFailed: 0, sessionClosed: 0, hostNotify: 0 },
  };
}

function applyEventToShadow(shadow: Shadow, event: SessionDriverEvent): void {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      shadow.status = event.snapshot.status;
      break;
    case "runFailed":
      shadow.status = "failed";
      break;
    case "sessionClosed":
      shadow.status = "idle";
      break;
    default:
      break;
  }

  if (
    event.type === "sessionUpdated" &&
    event.snapshot.status === "running" &&
    event.snapshot.runningRunId !== undefined &&
    shadow.runningSince === undefined
  ) {
    shadow.runningSince = event.timestamp;
  }
  if (event.type === "runCompleted" || event.type === "runFailed" || event.type === "sessionClosed") {
    shadow.runningSince = undefined;
  }

  if (event.type === "assistantDelta") {
    shadow.activeAssistantText = (shadow.activeAssistantText ?? "") + event.text;
  }
  // The active assistant message is cleared (but not removed) by these events.
  if (
    event.type === "toolStarted" ||
    event.type === "queuedMessageStarted" ||
    event.type === "runCompleted" ||
    event.type === "runFailed" ||
    event.type === "sessionClosed"
  ) {
    shadow.activeAssistantText = undefined;
  }

  switch (event.type) {
    case "sessionOpened":
      shadow.counts.sessionOpened += 1;
      break;
    case "runCompleted":
      shadow.counts.runCompleted += 1;
      break;
    case "runFailed":
      shadow.counts.runFailed += 1;
      break;
    case "sessionClosed":
      shadow.counts.sessionClosed += 1;
      break;
    case "hostUiRequest":
      if (event.request.kind === "notify") {
        shadow.counts.hostNotify += 1;
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// transcript helpers
// ---------------------------------------------------------------------------

function lastAssistantMessage(transcript: readonly TranscriptMessage[]): Extract<TranscriptMessage, { kind: "message" }> | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item && item.kind === "message" && item.role === "assistant") {
      return item;
    }
  }
  return undefined;
}

function toolRow(
  transcript: readonly TranscriptMessage[],
  callId: string,
): Extract<TranscriptMessage, { kind: "tool" }> | undefined {
  return transcript.find(
    (item): item is Extract<TranscriptMessage, { kind: "tool" }> =>
      item.kind === "tool" && item.callId === callId,
  );
}

function countActivityWithLabel(transcript: readonly TranscriptMessage[], label: string): number {
  return transcript.filter((item) => item.kind === "activity" && item.label === label).length;
}

function countErrorActivities(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((item) => item.kind === "activity" && item.tone === "error").length;
}

function countSummaryItems(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((item) => item.kind === "summary").length;
}

/**
 * Canonical content signature of a transcript, excluding random identity fields
 * (id/createdAt) and locale-sensitive metadata — used for replay-determinism and
 * order-independence comparisons.
 */
function transcriptSignature(transcript: readonly TranscriptMessage[]): unknown[] {
  return transcript.map((item) => {
    switch (item.kind) {
      case "message":
        return { kind: item.kind, role: item.role, text: item.text, attachments: item.attachments };
      case "tool":
        return {
          kind: item.kind,
          callId: item.callId,
          toolName: item.toolName,
          status: item.status,
          label: item.label,
          detail: item.detail,
          input: item.input,
          output: item.output,
        };
      case "activity":
        return { kind: item.kind, label: item.label, tone: item.tone, detail: item.detail };
      case "summary":
        return { kind: item.kind, label: item.label, presentation: item.presentation };
    }
  });
}

function sortedSignature(transcript: readonly TranscriptMessage[]): unknown[] {
  return transcriptSignature(transcript).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

// ---------------------------------------------------------------------------
// initial state containing the fixed target session
// ---------------------------------------------------------------------------

function makeInitialState(): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: TARGET_WORKSPACE_ID,
    selectedSessionId: TARGET_SESSION_ID,
    workspaces: [
      {
        id: TARGET_WORKSPACE_ID,
        name: "pbt workspace",
        path: "/tmp/pbt-ws",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        kind: "primary",
        sessions: [
          {
            id: TARGET_SESSION_ID,
            title: "pbt session",
            updatedAt: "2026-01-01T00:00:00.000Z",
            preview: "",
            status: "idle",
            hasUnseenUpdate: false,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// event generator — coherent: every event targets the existing session
// ---------------------------------------------------------------------------

function makeEventArb(sessionRef: SessionRef): fc.Arbitrary<SessionDriverEvent> {
  const snapshotArb = fc.record({
    ref: fc.constant(sessionRef),
    workspace: fc.constant({ workspaceId: sessionRef.workspaceId, path: "/tmp/pbt-ws" }),
    title: fc.string({ minLength: 1, maxLength: 40 }),
    status: fc.constantFrom("idle" as const, "running" as const, "failed" as const),
    updatedAt: tsArb,
    archivedAt: fc.option(tsArb, { nil: undefined }),
    preview: fc.option(fc.string(), { nil: undefined }),
    config: fc.option(
      fc.record({
        provider: fc.option(fc.string(), { nil: undefined }),
        modelId: fc.option(fc.string(), { nil: undefined }),
        thinkingLevel: fc.option(fc.string(), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    runningRunId: fc.option(fc.uuid(), { nil: undefined }),
    queuedMessages: fc.constant([] as readonly SessionQueuedMessage[]),
  });

  const queuedMessageArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 24 }),
    mode: fc.constantFrom("steer" as const, "followUp" as const),
    text: fc.string({ maxLength: 60 }),
    attachments: fc.constant([] as SessionQueuedMessage["attachments"]),
    createdAt: tsArb,
    updatedAt: tsArb,
  });

  return fc.oneof(
    fc.record({
      type: fc.constant("assistantDelta" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      text: fc.string({ maxLength: 60 }),
    }),
    fc.record({
      type: fc.constant("sessionOpened" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      snapshot: snapshotArb,
    }),
    fc.record({
      type: fc.constant("sessionUpdated" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      snapshot: snapshotArb,
    }),
    fc.record({
      type: fc.constant("queuedMessageStarted" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      message: queuedMessageArb,
    }),
    fc.record({
      type: fc.constant("toolStarted" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      toolName: fc.string({ minLength: 1, maxLength: 40 }),
      callId: fc.string({ minLength: 1, maxLength: 24 }),
      input: fc.option(fc.jsonValue(), { nil: undefined }),
    }),
    fc.record({
      type: fc.constant("toolUpdated" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      callId: fc.string({ minLength: 1, maxLength: 24 }),
      text: fc.option(fc.string(), { nil: undefined }),
      progress: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
    }),
    fc.record({
      type: fc.constant("toolFinished" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      callId: fc.string({ minLength: 1, maxLength: 24 }),
      success: fc.boolean(),
      output: fc.option(fc.jsonValue(), { nil: undefined }),
    }),
    fc.record({
      type: fc.constant("runCompleted" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      snapshot: snapshotArb,
    }),
    fc.record({
      type: fc.constant("runFailed" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      error: fc.record({
        message: fc.string({ minLength: 1, maxLength: 60 }),
        code: fc.option(fc.string(), { nil: undefined }),
      }),
    }),
    fc.record({
      type: fc.constant("sessionClosed" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      reason: fc.constantFrom("manual" as const, "ended" as const, "failed" as const),
    }),
    fc.record({
      type: fc.constant("hostUiRequest" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      request: fc.record({
        kind: fc.constant("notify" as const),
        requestId: fc.string({ minLength: 1 }),
        message: fc.string({ maxLength: 60 }),
        level: fc.option(fc.constantFrom("info" as const, "warning" as const, "error" as const), { nil: undefined }),
      }),
    }),
    fc.record({
      type: fc.constant("extensionCompatibilityIssue" as const),
      sessionRef: fc.constant(sessionRef),
      timestamp: tsArb,
      issue: fc.record({
        capability: fc.string({ minLength: 1 }),
        classification: fc.constant("terminal-only" as const),
        message: fc.string({ minLength: 1 }),
      }),
    }),
  );
}

const targetEventArb = makeEventArb(TARGET_SESSION_REF);

// ---------------------------------------------------------------------------
// 1. state machine: arbitrary event sequences keep DesktopAppState consistent
// ---------------------------------------------------------------------------

test("state machine: arbitrary event sequences preserve invariants step by step", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(targetEventArb, { maxLength: 40 }), async (events) => {
      const key = sessionKey(TARGET_SESSION_REF);
      const caches = freshCaches();
      const shadow = freshShadow();
      let state = makeInitialState();
      const startRevision = state.revision;

      for (const [index, event] of events.entries()) {
        // No event may throw.
        driveEvent(caches, event);
        state = applySessionEventState(
          state,
          event,
          caches.transcriptCache,
          caches.runningSinceBySession,
          caches.lastViewedAtBySession,
        );
        applyEventToShadow(shadow, event);

        // (a) revision strictly increases by 1 per event.
        assert.equal(state.revision, startRevision + index + 1, `revision after event ${index}`);

        // (c) the target workspace and session always exist.
        const workspace = state.workspaces.find((candidate) => candidate.id === TARGET_WORKSPACE_ID);
        assert.ok(workspace, `target workspace present after event ${index}`);
        const session = workspace!.sessions.find((candidate) => candidate.id === TARGET_SESSION_ID);
        assert.ok(session, `target session present after event ${index}`);

        // session record mirrors the event semantics.
        assert.equal(session!.status, shadow.status, `session status after event ${index}`);
        assert.equal(
          session!.runningSince,
          shadow.runningSince,
          `runningSince after event ${index} (event=${event.type})`,
        );

        // preview is derived from the transcript whenever the transcript yields one.
        const transcript = caches.transcriptCache.get(key) ?? [];
        const derivedPreview = previewFromTranscript(transcript);
        if (derivedPreview !== undefined) {
          assert.equal(session!.preview, derivedPreview, `preview derived from transcript after event ${index}`);
        }

        // (b) each event's effect is reflected in the transcript accumulation.
        switch (event.type) {
          case "assistantDelta":
            if (shadow.activeAssistantText !== undefined) {
              const active = lastAssistantMessage(transcript);
              assert.ok(active, `delta must leave an assistant message (event ${index})`);
              assert.equal(
                active!.text,
                shadow.activeAssistantText,
                `assistantDelta appends to the active assistant message (event ${index})`,
              );
            }
            break;
          case "sessionOpened":
            assert.ok(
              transcript.some((item) => item.kind === "activity" && item.label === "Resumed session"),
              `sessionOpened adds a Resumed session activity (event ${index})`,
            );
            break;
          case "queuedMessageStarted": {
            const message = transcript.find(
              (item) => item.kind === "message" && item.id === event.message.id,
            );
            assert.ok(
              message && message.kind === "message" && message.role === "user",
              `queuedMessageStarted upserts the user message (event ${index})`,
            );
            assert.equal(message!.text, event.message.text, `user message text matches (event ${index})`);
            break;
          }
          case "toolStarted": {
            const row = toolRow(transcript, event.callId);
            assert.ok(row, `toolStarted creates a tool row (event ${index})`);
            assert.equal(row!.status, "running", `toolStarted row is running (event ${index})`);
            break;
          }
          case "toolUpdated":
            assert.ok(toolRow(transcript, event.callId), `toolUpdated upserts the tool row (event ${index})`);
            break;
          case "toolFinished": {
            const row = toolRow(transcript, event.callId);
            assert.ok(row, `toolFinished upserts the tool row (event ${index})`);
            assert.equal(
              row!.status,
              event.success ? "success" : "error",
              `toolFinished sets the terminal tool status (event ${index})`,
            );
            break;
          }
          case "runCompleted":
            assert.ok(
              transcript.some((item) => item.kind === "summary"),
              `runCompleted adds a summary (event ${index})`,
            );
            break;
          case "runFailed":
            assert.ok(
              transcript.some((item) => item.kind === "activity" && item.tone === "error"),
              `runFailed adds an error activity (event ${index})`,
            );
            break;
          case "sessionClosed":
            assert.ok(
              transcript.some((item) => item.kind === "activity" && item.label === "Stopped"),
              `sessionClosed adds a Stopped activity (event ${index})`,
            );
            break;
          case "hostUiRequest": {
            const request = event.request;
            if (request.kind === "notify") {
              assert.ok(
                transcript.some((item) => item.kind === "activity" && item.label === request.message),
                `notify adds its message as an activity (event ${index})`,
              );
            }
            break;
          }
          default:
            // extensionCompatibilityIssue has no transcript effect; no-throw is the contract.
            break;
        }

        // accumulating exact counters (each producer event pushes exactly one row).
        assert.equal(
          countActivityWithLabel(transcript, "Resumed session"),
          shadow.counts.sessionOpened,
          `one Resumed session per sessionOpened (event ${index})`,
        );
        assert.equal(
          countActivityWithLabel(transcript, "Stopped"),
          shadow.counts.sessionClosed,
          `one Stopped per sessionClosed (event ${index})`,
        );
        assert.equal(
          countErrorActivities(transcript),
          shadow.counts.runFailed,
          `one error activity per runFailed (event ${index})`,
        );
        assert.ok(
          countSummaryItems(transcript) >= shadow.counts.runCompleted,
          `at least one summary per runCompleted (event ${index})`,
        );
      }
    }),
    { numRuns: 60 },
  );
});

// ---------------------------------------------------------------------------
// 2. order independence for genuinely commuting events
// ---------------------------------------------------------------------------

function runSequence(events: readonly SessionDriverEvent[]): {
  transcript: TranscriptMessage[];
  status: ShadowStatus;
  preview: string;
  runningSince: string | undefined;
  revision: number;
} {
  const caches = freshCaches();
  let state = makeInitialState();
  for (const event of events) {
    driveEvent(caches, event);
    state = applySessionEventState(
      state,
      event,
      caches.transcriptCache,
      caches.runningSinceBySession,
      caches.lastViewedAtBySession,
    );
  }
  const session = state.workspaces[0]!.sessions[0]!;
  return {
    transcript: caches.transcriptCache.get(sessionKey(TARGET_SESSION_REF)) ?? [],
    status: session.status,
    preview: session.preview,
    runningSince: session.runningSince,
    revision: state.revision,
  };
}

function assertEquivalentRuns(left: ReturnType<typeof runSequence>, right: ReturnType<typeof runSequence>): void {
  assert.equal(left.revision, right.revision);
  assert.equal(left.status, right.status);
  assert.equal(left.preview, right.preview);
  assert.equal(left.runningSince, right.runningSince);
}

const idleSnapshotArb = fc.record({
  ref: fc.constant(TARGET_SESSION_REF),
  workspace: fc.constant({ workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/pbt-ws" }),
  title: fc.string({ minLength: 1, maxLength: 40 }),
  status: fc.constant("idle" as const),
  updatedAt: tsArb,
  queuedMessages: fc.constant([] as readonly SessionQueuedMessage[]),
});

test("order independence: assistantDelta + sessionUpdated(idle) commute exactly", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 40 }), idleSnapshotArb, async (deltaText, snapshot) => {
      const delta: SessionDriverEvent = {
        type: "assistantDelta",
        sessionRef: TARGET_SESSION_REF,
        timestamp: "2026-06-01T00:00:00.000Z",
        text: deltaText,
      };
      const updated: SessionDriverEvent = {
        type: "sessionUpdated",
        sessionRef: TARGET_SESSION_REF,
        timestamp: "2026-06-01T00:00:01.000Z",
        snapshot,
      };

      const forward = runSequence([delta, updated]);
      const backward = runSequence([updated, delta]);
      assertEquivalentRuns(forward, backward);
      assert.deepEqual(transcriptSignature(forward.transcript), transcriptSignature(backward.transcript));
    }),
    { numRuns: 40 },
  );
});

test("order independence: toolStarted + toolUpdated converge on the same tool row", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 24 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ maxLength: 60 }),
      async (callId, toolName, progressText) => {
        const started: SessionDriverEvent = {
          type: "toolStarted",
          sessionRef: TARGET_SESSION_REF,
          timestamp: "2026-06-01T00:00:00.000Z",
          toolName,
          callId,
          input: { path: "/tmp/pbt-ws/file.ts" },
        };
        const updated: SessionDriverEvent = {
          type: "toolUpdated",
          sessionRef: TARGET_SESSION_REF,
          timestamp: "2026-06-01T00:00:01.000Z",
          callId,
          text: progressText,
        };

        const forward = runSequence([started, updated]);
        const backward = runSequence([updated, started]);
        assertEquivalentRuns(forward, backward);
        assert.deepEqual(transcriptSignature(forward.transcript), transcriptSignature(backward.transcript));
        assert.equal(transcriptSignature(forward.transcript).length, 1, "exactly one tool row either way");
      },
    ),
    { numRuns: 40 },
  );
});

test("order independence: distinct queuedMessageStarted events commute in content", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 24 }),
      fc.string({ minLength: 1, maxLength: 24 }),
      fc.string({ maxLength: 60 }),
      fc.string({ maxLength: 60 }),
      async (firstId, secondId, firstText, secondText) => {
        fc.pre(firstId !== secondId);
        const first: SessionDriverEvent = {
          type: "queuedMessageStarted",
          sessionRef: TARGET_SESSION_REF,
          timestamp: "2026-06-01T00:00:00.000Z",
          message: {
            id: firstId,
            mode: "steer",
            text: firstText,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        };
        const second: SessionDriverEvent = {
          type: "queuedMessageStarted",
          sessionRef: TARGET_SESSION_REF,
          timestamp: "2026-06-01T00:00:01.000Z",
          message: {
            id: secondId,
            mode: "followUp",
            text: secondText,
            createdAt: "2026-06-01T00:00:01.000Z",
            updatedAt: "2026-06-01T00:00:01.000Z",
          },
        };

        const forward = runSequence([first, second]);
        const backward = runSequence([second, first]);
        // Transcript content commutes, but the session preview (last message
        // text) legitimately follows message order, so only the content and
        // order-independent record fields are compared here.
        assert.equal(forward.transcript.length, backward.transcript.length);
        assert.deepEqual(sortedSignature(forward.transcript), sortedSignature(backward.transcript));
        assert.equal(forward.status, backward.status);
        assert.equal(forward.revision, backward.revision);
      },
    ),
    { numRuns: 40 },
  );
});

test("contrast: toolStarted + toolFinished do NOT commute (spec lock)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 24 }), fc.string({ minLength: 1, maxLength: 40 }), (callId, toolName) => {
      const started: SessionDriverEvent = {
        type: "toolStarted",
        sessionRef: TARGET_SESSION_REF,
        timestamp: "2026-06-01T00:00:00.000Z",
        toolName,
        callId,
      };
      const finished: SessionDriverEvent = {
        type: "toolFinished",
        sessionRef: TARGET_SESSION_REF,
        timestamp: "2026-06-01T00:00:01.000Z",
        callId,
        success: true,
        output: "done",
      };

      const forward = runSequence([started, finished]);
      const backward = runSequence([finished, started]);
      assert.notDeepEqual(transcriptSignature(forward.transcript), transcriptSignature(backward.transcript));
      const forwardRow = toolRow(forward.transcript, callId);
      const backwardRow = toolRow(backward.transcript, callId);
      assert.equal(forwardRow?.status, "success");
      assert.equal(backwardRow?.status, "running");
    }),
    { numRuns: 20 },
  );
});

// ---------------------------------------------------------------------------
// 3. restart/replay determinism
// ---------------------------------------------------------------------------

test("restart/replay: the same sequence with fresh caches reproduces identical transcript content", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(targetEventArb, { maxLength: 40 }), (events) => {
      const first = runSequence(events);
      const second = runSequence(events);
      assert.deepEqual(
        transcriptSignature(first.transcript),
        transcriptSignature(second.transcript),
        "replayed transcript content must be identical",
      );
      assert.deepEqual(
        { status: first.status, preview: first.preview, runningSince: first.runningSince, revision: first.revision },
        { status: second.status, preview: second.preview, runningSince: second.runningSince, revision: second.revision },
      );
    }),
    { numRuns: 60 },
  );
});

// ---------------------------------------------------------------------------
// 4. full flow: catalogs → buildWorkspaceRecords → events → DesktopAppState
// ---------------------------------------------------------------------------

const workspaceEntryArb: fc.Arbitrary<WorkspaceCatalogEntry> = fc.record({
  workspaceId: fc.uuid(),
  path: fc.string({ minLength: 1, maxLength: 80 }),
  displayName: fc.string({ minLength: 1, maxLength: 40 }),
  lastOpenedAt: tsArb,
  sortOrder: fc.integer({ min: 0, max: 100 }),
  pinned: fc.option(fc.boolean(), { nil: undefined }),
});

function sessionEntryArb(workspaces: readonly WorkspaceCatalogEntry[]): fc.Arbitrary<SessionCatalogEntry> {
  const workspaceIdArb = fc.constantFrom(...workspaces.map((workspace) => workspace.workspaceId));
  return fc
    .record({
      workspaceId: workspaceIdArb,
      sessionId: fc
        .string({ minLength: 1, maxLength: 24 })
        .filter((id) => !id.includes(":") && id !== "pbt-target-session"),
      title: fc.string({ minLength: 1, maxLength: 40 }),
      updatedAt: tsArb,
      archivedAt: fc.option(tsArb, { nil: undefined }),
      previewSnippet: fc.option(fc.string(), { nil: undefined }),
      status: fc.constantFrom("idle" as const, "running" as const, "failed" as const),
    })
    .map(({ workspaceId, sessionId, ...rest }) => ({
      ...rest,
      workspaceId,
      sessionRef: { workspaceId, sessionId },
    }));
}

test("full flow: catalog → buildWorkspaceRecords → events keeps selection valid, revision exact, previews derived", async () => {
  const property = fc
    .array(workspaceEntryArb, { minLength: 1, maxLength: 4 })
    .chain((workspaces) => {
      const targetWorkspace = workspaces[0]!;
      const targetRef: SessionRef = {
        workspaceId: targetWorkspace.workspaceId,
        sessionId: "pbt-target-session",
      };
      const targetEntry: SessionCatalogEntry = {
        sessionRef: targetRef,
        workspaceId: targetRef.workspaceId,
        title: "pbt target session",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "idle",
      };
      const extraSessionsArb = fc.array(sessionEntryArb(workspaces), { maxLength: 5 });
      const eventsArb = fc.array(makeEventArb(targetRef), { maxLength: 30 });
      return fc.tuple(extraSessionsArb, eventsArb).map(([extraSessions, events]) => ({
        workspaces,
        sessions: [targetEntry, ...extraSessions],
        targetRef,
        events,
      }));
    });

  await fc.assert(
    fc.asyncProperty(property, async ({ workspaces, sessions, targetRef, events }) => {
      const caches = freshCaches();
      const sessionConfigBySession = new Map();
      const pinnedAtBySession = new Map();

      const workspaceRecords = buildWorkspaceRecords(
        workspaces,
        [],
        sessions,
        caches.transcriptCache,
        caches.runningSinceBySession,
        sessionConfigBySession,
        caches.lastViewedAtBySession,
        pinnedAtBySession,
      );

      let state: DesktopAppState = {
        ...createEmptyDesktopAppState(),
        selectedWorkspaceId: targetRef.workspaceId,
        selectedSessionId: targetRef.sessionId,
        workspaces: workspaceRecords,
      };
      const startRevision = state.revision;

      for (const event of events) {
        driveEvent(caches, event);
        state = applySessionEventState(
          state,
          event,
          caches.transcriptCache,
          caches.runningSinceBySession,
          caches.lastViewedAtBySession,
        );
      }

      // selection still references an existing workspace and session
      const selectedWorkspace = state.workspaces.find((candidate) => candidate.id === state.selectedWorkspaceId);
      assert.ok(selectedWorkspace, "selected workspace must still exist");
      assert.ok(
        selectedWorkspace!.sessions.some((candidate) => candidate.id === state.selectedSessionId),
        "selected session must still exist",
      );

      // revision advanced by exactly the number of events
      assert.equal(state.revision, startRevision + events.length, "revision advances by exactly the event count");

      // every session preview derives from its transcript when the transcript yields one
      for (const workspace of state.workspaces) {
        for (const session of workspace.sessions) {
          const transcript = caches.transcriptCache.get(sessionKey({ workspaceId: workspace.id, sessionId: session.id }));
          const derivedPreview = transcript ? previewFromTranscript(transcript) : undefined;
          if (derivedPreview !== undefined) {
            assert.equal(session.preview, derivedPreview, `preview derived from transcript for ${session.id}`);
          } else {
            assert.equal(typeof session.preview, "string", `preview is a string for ${session.id}`);
          }
        }
      }
    }),
    { numRuns: 40 },
  );
});
