/**
 * Cardo integrated PBT: the snapshot + delta transcript delivery contract.
 *
 * Pipeline under test (mirrors electron/main.ts publishSelectedTranscriptToWindow
 * + the renderer's useDesktopAppState, using the compiled pure modules):
 *
 *   driver events (ONE per text delta) →
 *     driveEvent (appendAssistantDelta / applyTimelineEvent → transcriptCache)
 *     applySessionEventState → DesktopAppState
 *     publish decision (decideTranscriptDelivery against the last published
 *       snapshot) → full SelectedTranscriptRecord OR incremental ops
 *     renderer side: applyTranscriptDelta onto its local transcript
 *
 * The full-delivery contract (streaming-sync.test.mts) locks the CONTENT of the
 * whole-transcript snapshots; this suite locks the DELTA contract:
 *
 *  E. Convergence — no matter how events are batched into publishes (coalescing
 *     is arbitrary at the renderer), applying the delivered ops to the
 *     renderer's local transcript always reproduces the store cache exactly
 *     (content equality, item-for-item, same order).
 *  F. No-loss / no-dup content accounting through the delta path — every
 *     assistantDelta/assistantThinkingDelta text lands in the renderer's local
 *     transcript exactly once.
 *  G. Id/kind stability under upsert — an upsert of an existing id never
 *     changes its kind, and message/thinking text only grows (never rewinds).
 *  H. Liveness — the cost of delivering one more delta is bounded by the number
 *     of items that actually changed since the last publish, INDEPENDENT of the
 *     transcript length already delivered. A long-running session with many
 *     prior deltas must not make the next delta more expensive (no O(n) payload
 *     growth). This is the property the reported symptom violates: full
 *     snapshots make per-delta cost grow with transcript length, so the UI
 *     falls irrecoverably behind.
 *  I. Delivery decision — a session switch (or first publish) is always a full
 *     snapshot, never a delta; unchanged content publishes nothing (empty ops).
 *  J. Reference stability on the renderer side — applyTranscriptDelta keeps the
 *     object identity of untouched items, so the timeline memo comparator
 *     (sameDisplayItemContent) short-circuits on reference equality instead of
 *     JSON.stringify-ing every row per snapshot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  appendAssistantDelta,
  appendThinkingDelta,
  applyTimelineEvent,
  finalizeActiveThinking,
  // Cardo: T1 — the transcript cache value is now the persistent chunked entry.
  type TranscriptCacheEntry,
} from "../../out-pbt/desktop/electron/app-store-timeline.js";
import { applySessionEventState } from "../../out-pbt/desktop/electron/app-store-session-state.js";
import { cloneTranscriptMessage } from "../../out-pbt/desktop/electron/app-store-utils.js";
import { createEmptyDesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import type { DesktopAppState, TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";
import {
  applyTranscriptDelta,
  computeTranscriptDelta,
  decideTranscriptDelivery,
  sameTranscriptItemContent,
  type PublishedTranscriptSnapshot,
  type TranscriptDeltaOp,
} from "../../out-pbt/desktop/src/transcript-delta.js";
import { sameDisplayItemContent } from "../../out-pbt/desktop/src/timeline-turns.js";

/* ── fixed target session ───────────────────────────────── */

const TARGET_WORKSPACE_ID = "delta-ws";
const TARGET_SESSION_ID = "delta-session";
const TARGET_SESSION_REF: SessionRef = { workspaceId: TARGET_WORKSPACE_ID, sessionId: TARGET_SESSION_ID };
const KEY = sessionKey(TARGET_SESSION_REF);

const OTHER_SESSION_REF: SessionRef = { workspaceId: TARGET_WORKSPACE_ID, sessionId: "other-session" };

/* ── caches + the real flow driver (mirrors app-store) ──── */

interface FlowCaches {
  // Cardo: T1 — persistent chunked entry instead of a plain array.
  transcriptCache: Map<string, TranscriptCacheEntry>;
  runningSinceBySession: Map<string, string>;
  lastViewedAtBySession: Map<string, string>;
  activeAssistantMessageBySession: Map<string, string>;
  activeWorkingActivityBySession: Map<string, string>;
  activeThinkingBySession: Map<string, { id: string; text: string; startedAt: string }>;
  runMetricsBySession: Map<string, { startedAt: string; toolCount: number; searchCount: number; fileCount: number }>;
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

/** Mirrors electron/app-store.ts handleSessionEvent ordering for delta events. */
function driveEvent(caches: FlowCaches, event: SessionDriverEvent): void {
  if (event.type === "assistantDelta") {
    finalizeActiveThinking(caches.transcriptCache, caches.activeThinkingBySession, event.sessionRef);
    appendAssistantDelta(
      caches.transcriptCache,
      caches.activeAssistantMessageBySession,
      event.sessionRef,
      event.text,
    );
  } else if (event.type === "assistantThinkingDelta") {
    appendThinkingDelta(caches.transcriptCache, caches.activeThinkingBySession, event.sessionRef, event.text);
  }
  applyTimelineEvent(caches.transcriptCache, event, {
    runMetricsBySession: caches.runMetricsBySession,
    runningSinceBySession: caches.runningSinceBySession,
    activeAssistantMessageBySession: caches.activeAssistantMessageBySession,
    activeWorkingActivityBySession: caches.activeWorkingActivityBySession,
    activeThinkingBySession: caches.activeThinkingBySession,
  });
}

function makeInitialState(): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: TARGET_WORKSPACE_ID,
    selectedSessionId: TARGET_SESSION_ID,
    workspaces: [
      {
        id: TARGET_WORKSPACE_ID,
        name: "delta workspace",
        path: "/tmp/delta-ws",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        kind: "primary",
        sessions: [
          {
            id: TARGET_SESSION_ID,
            title: "delta session",
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

/* ── coherent event generator (fixed, parseable timestamps) ── */

const tsArb = fc
  .integer({ min: Date.parse("2026-01-01T00:00:00.000Z"), max: Date.parse("2026-12-31T23:59:59.999Z") })
  .map((ms) => new Date(ms).toISOString());

const snapshotArb = fc.record({
  ref: fc.constant(TARGET_SESSION_REF),
  workspace: fc.constant({ workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/delta-ws" }),
  title: fc.string({ minLength: 1, maxLength: 40 }),
  status: fc.constantFrom("idle" as const, "running" as const, "failed" as const),
  updatedAt: tsArb,
  archivedAt: fc.option(tsArb, { nil: undefined }),
  preview: fc.option(fc.string(), { nil: undefined }),
  config: fc.constant(undefined),
  runningRunId: fc.option(fc.uuid(), { nil: undefined }),
  queuedMessages: fc.constant([] as never[]),
});

const deltaEventArb: fc.Arbitrary<SessionDriverEvent> = fc.oneof(
  fc.record({
    type: fc.constant("assistantDelta" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    text: fc.string({ maxLength: 60 }),
  }),
  fc.record({
    type: fc.constant("assistantThinkingDelta" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    text: fc.string({ maxLength: 60 }),
  }),
  fc.record({
    type: fc.constant("sessionOpened" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    snapshot: snapshotArb,
  }),
  fc.record({
    type: fc.constant("sessionUpdated" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    snapshot: snapshotArb,
  }),
  fc.record({
    type: fc.constant("queuedMessageStarted" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    message: fc.record({
      id: fc.uuid(),
      mode: fc.constant("followUp" as const),
      text: fc.string({ maxLength: 60 }),
      attachments: fc.constant([] as never[]),
      createdAt: tsArb,
      updatedAt: tsArb,
    }),
  }),
  fc.record({
    type: fc.constant("toolStarted" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    toolName: fc.string({ minLength: 1, maxLength: 40 }),
    callId: fc.uuid(),
    input: fc.option(fc.jsonValue(), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant("toolUpdated" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    callId: fc.uuid(),
    text: fc.option(fc.string(), { nil: undefined }),
    progress: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant("toolFinished" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    callId: fc.uuid(),
    success: fc.boolean(),
    output: fc.option(fc.jsonValue(), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant("runCompleted" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    snapshot: snapshotArb,
  }),
  fc.record({
    type: fc.constant("runFailed" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    error: fc.record({ message: fc.string({ minLength: 1, maxLength: 60 }), code: fc.option(fc.string(), { nil: undefined }) }),
  }),
  fc.record({
    type: fc.constant("sessionClosed" as const),
    sessionRef: fc.constant(TARGET_SESSION_REF),
    timestamp: tsArb,
    reason: fc.constant("manual" as const),
  }),
);

/* ── helpers ────────────────────────────────────────────── */

// Cardo: T1 — the cache entry mutates IN PLACE, so publish reads must
// materialize a snapshot (mirrors getSelectedTranscriptItemsForView → toArray()).
// Item objects are reused across snapshots, so the reference-accelerated delta
// diff still skips untouched items in O(1).
function transcriptOf(caches: FlowCaches): readonly TranscriptMessage[] {
  const entry = caches.transcriptCache.get(KEY);
  return entry === undefined ? [] : entry.toArray();
}

function sameTranscript(a: readonly TranscriptMessage[], b: readonly TranscriptMessage[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!sameTranscriptItemContent(a[index]!, b[index]!)) {
      return false;
    }
  }
  return true;
}

function assistantTextTotal(transcript: readonly TranscriptMessage[]): number {
  let total = 0;
  for (const item of transcript) {
    if (item.kind === "message" && item.role === "assistant") {
      total += item.text.length;
    }
  }
  return total;
}

function thinkingTextTotal(transcript: readonly TranscriptMessage[]): number {
  let total = 0;
  for (const item of transcript) {
    if (item.kind === "thinking") {
      total += item.text.length;
    }
  }
  return total;
}

/** Number of items that differ between `previous` and `current` (by id). */
function changedItemCount(previous: readonly TranscriptMessage[], current: readonly TranscriptMessage[]): number {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let changed = 0;
  for (const item of current) {
    const prev = previousById.get(item.id);
    if (prev === undefined || !sameTranscriptItemContent(prev, item)) {
      changed += 1;
    }
  }
  for (const item of previous) {
    if (!current.some((candidate) => candidate.id === item.id)) {
      changed += 1;
    }
  }
  return changed;
}

/* ── E. convergence through arbitrary coalescing ────────── */

test("convergence: renderer local transcript equals store cache under any publish batching", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(deltaEventArb, { maxLength: 80 }),
      fc.array(fc.boolean(), { maxLength: 80 }),
      async (events, publishMask) => {
        const caches = freshCaches();
        let state = makeInitialState();

        // Renderer-side state: null until the first full snapshot arrives.
        let rendererTranscript: readonly TranscriptMessage[] | null = null;
        let lastPublished: PublishedTranscriptSnapshot | undefined = undefined;

        for (let index = 0; index < events.length; index += 1) {
          const event = events[index]!;
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );

          const shouldPublish = publishMask[index] ?? false;
          if (!shouldPublish) {
            continue;
          }

          const current = {
            workspaceId: TARGET_WORKSPACE_ID,
            sessionId: TARGET_SESSION_ID,
            items: transcriptOf(caches),
          };
          const delivery = decideTranscriptDelivery(lastPublished, current);
          if (delivery.kind === "full") {
            // The main process clones before IPC; the renderer replaces its local copy.
            rendererTranscript = current.items.map(cloneTranscriptMessage);
            lastPublished = current;
          } else if (delivery.ops.length > 0) {
            rendererTranscript = applyTranscriptDelta(rendererTranscript ?? [], delivery.ops);
            lastPublished = current;
          }
          // Empty delta: nothing changes, renderer state untouched.

          if (rendererTranscript !== null) {
            assert.ok(
              sameTranscript(rendererTranscript, transcriptOf(caches)),
              "renderer local transcript must converge to the store cache after every publish",
            );
          }
        }
      },
    ),
    { numRuns: 80 },
  );
});

/* ── F. no-loss / no-dup content accounting (delta path) ── */

test("content accounting: every delta text lands in the renderer transcript exactly once", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(deltaEventArb, { maxLength: 80 }), async (events) => {
      const caches = freshCaches();
      let state = makeInitialState();
      let rendererTranscript: readonly TranscriptMessage[] | null = null;
      let lastPublished: PublishedTranscriptSnapshot | undefined = undefined;
      let deliveredAssistantChars = 0;
      let deliveredThinkingChars = 0;

      // Publish after every event (worst case: no coalescing).
      for (const event of events) {
        driveEvent(caches, event);
        state = applySessionEventState(
          state,
          event,
          caches.transcriptCache,
          caches.runningSinceBySession,
          caches.lastViewedAtBySession,
        );
        if (event.type === "assistantDelta") {
          deliveredAssistantChars += event.text.length;
        } else if (event.type === "assistantThinkingDelta") {
          deliveredThinkingChars += event.text.length;
        }

        const current = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        const delivery = decideTranscriptDelivery(lastPublished, current);
        if (delivery.kind === "full") {
          rendererTranscript = current.items.map(cloneTranscriptMessage);
          lastPublished = current;
        } else if (delivery.ops.length > 0) {
          rendererTranscript = applyTranscriptDelta(rendererTranscript ?? [], delivery.ops);
          lastPublished = current;
        }
      }

      const finalTranscript = rendererTranscript ?? [];
      assert.equal(
        assistantTextTotal(finalTranscript),
        deliveredAssistantChars,
        "assistant delta text must be preserved exactly through the delta path (no loss, no duplication)",
      );
      assert.equal(
        thinkingTextTotal(finalTranscript),
        deliveredThinkingChars,
        "thinking delta text must be preserved exactly through the delta path (no loss, no duplication)",
      );
    }),
    { numRuns: 80 },
  );
});

/* ── G. id/kind stability under upsert ──────────────────── */

test("identity: upsert never changes kind, message/thinking text only grows", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(deltaEventArb, { maxLength: 80 }), async (events) => {
      const caches = freshCaches();
      let state = makeInitialState();
      let rendererTranscript: readonly TranscriptMessage[] | null = null;
      let lastPublished: PublishedTranscriptSnapshot | undefined = undefined;
      const previousById = new Map<string, { kind: string; text: string }>();

      for (const event of events) {
        const workingActivityIdBefore = caches.activeWorkingActivityBySession.get(KEY);
        driveEvent(caches, event);
        state = applySessionEventState(
          state,
          event,
          caches.transcriptCache,
          caches.runningSinceBySession,
          caches.lastViewedAtBySession,
        );

        const current = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        const delivery = decideTranscriptDelivery(lastPublished, current);
        if (delivery.kind === "full") {
          rendererTranscript = current.items.map(cloneTranscriptMessage);
          lastPublished = current;
        } else if (delivery.ops.length > 0) {
          rendererTranscript = applyTranscriptDelta(rendererTranscript ?? [], delivery.ops);
          lastPublished = current;
        }

        if (rendererTranscript === null) {
          continue;
        }
        const transcript = rendererTranscript;
        const idsNow = new Set<string>();
        for (const item of transcript) {
          idsNow.add(item.id);
          const previous = previousById.get(item.id);
          if (!previous) {
            continue;
          }
          assert.equal(item.kind, previous.kind, `item ${item.id} must never change kind`);
          if (item.kind === "message" || item.kind === "thinking") {
            const text = (item as { text: string }).text;
            assert.ok(
              text.startsWith(previous.text),
              `item ${item.id} text must only grow (${previous.text.length} → ${text.length})`,
            );
          }
        }
        for (const [id, previous] of previousById) {
          if (!idsNow.has(id)) {
            assert.equal(
              id,
              workingActivityIdBefore,
              `item ${id} (${previous.kind}) must never vanish from the renderer transcript`,
            );
          }
        }

        previousById.clear();
        for (const item of transcript) {
          previousById.set(item.id, {
            kind: item.kind,
            text: item.kind === "message" || item.kind === "thinking" ? (item as { text: string }).text : "",
          });
        }
      }
    }),
    { numRuns: 80 },
  );
});

/* ── H. liveness: per-delta cost bounded by actual changes ── */

test("liveness: delta ops are bounded by changed items, independent of transcript length", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(deltaEventArb, { minLength: 20, maxLength: 80 }),
      async (seedEvents) => {
        const caches = freshCaches();
        let state = makeInitialState();
        let lastPublished: PublishedTranscriptSnapshot | undefined = undefined;

        // Drive a long-running session: deliver everything so the snapshot is large.
        for (const event of seedEvents) {
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );
        }
        const baseline = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        lastPublished = baseline;

        // One more delta on a long transcript: ops must be ≤ the items actually
        // changed by that single event, never the whole transcript.
        const single = fc.sample(deltaEventArb, 1)[0]!;
        driveEvent(caches, single);
        state = applySessionEventState(
          state,
          single,
          caches.transcriptCache,
          caches.runningSinceBySession,
          caches.lastViewedAtBySession,
        );
        const current = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        const ops = computeTranscriptDelta(baseline.items, current.items);
        const changed = changedItemCount(baseline.items, current.items);

        assert.ok(
          ops.length <= changed,
          `delta ops (${ops.length}) must never exceed actually-changed items (${changed})`,
        );
        // A single text delta touches at most two items: the in-flight thinking
        // row is finalized (upsert) when the first assistant text arrives, and
        // the active assistant message grows (upsert). The bound is constant —
        // independent of how long the transcript already is.
        if (single.type === "assistantDelta" || single.type === "assistantThinkingDelta") {
          assert.ok(
            ops.length <= 2,
            `a single text delta must ship at most 2 ops (finalized thinking + active message), got ${ops.length} for ${single.type}`,
          );
        }
      },
    ),
    { numRuns: 60 },
  );
});

/* ── I. delivery decision: full on switch/first, empty on no-change ── */

test("delivery decision: session switch and first publish are full; no-change publishes nothing", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(deltaEventArb, { maxLength: 60 }),
      fc.array(deltaEventArb, { maxLength: 60 }),
      async (firstEvents, secondEvents) => {
        const caches = freshCaches();
        let state = makeInitialState();

        // First publish with no prior snapshot → always full.
        let lastPublished: PublishedTranscriptSnapshot | undefined = undefined;
        const firstCurrent = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        assert.equal(decideTranscriptDelivery(undefined, firstCurrent).kind, "full");
        assert.equal(decideTranscriptDelivery(undefined, null).kind, "full");

        // Drive some events, publish a full snapshot.
        for (const event of firstEvents) {
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );
        }
        const snapshotCurrent = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        lastPublished = snapshotCurrent;

        // No new events → delta with zero ops (nothing to publish).
        const noopDelivery = decideTranscriptDelivery(lastPublished, snapshotCurrent);
        assert.equal(noopDelivery.kind, "delta");
        assert.equal(noopDelivery.ops.length, 0, "unchanged content must publish zero ops");

        // Switching to another session → full, never a delta.
        const switched = decideTranscriptDelivery(lastPublished, {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: OTHER_SESSION_REF.sessionId,
          items: [],
        });
        assert.equal(switched.kind, "full", "session switch must always ship a full snapshot");

        // A genuinely changed session publishes a non-empty delta (or a full if
        // the session was never published, which can't happen here).
        for (const event of secondEvents) {
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );
        }
        const changedCurrent = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };
        const changedDelivery = decideTranscriptDelivery(lastPublished, changedCurrent);
        if (changedCurrent.items.length !== snapshotCurrent.items.length) {
          assert.equal(changedDelivery.kind, "delta");
          assert.ok(changedDelivery.ops.length > 0, "changed content must publish ops");
        }
      },
    ),
    { numRuns: 60 },
  );
});

/* ── J. reference stability + memo comparator semantics ──── */

test("reference stability: applyTranscriptDelta keeps untouched item identity (memo short-circuit)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(deltaEventArb, { minLength: 5, maxLength: 60 }),
      fc.array(deltaEventArb, { maxLength: 60 }),
      async (seedEvents, laterEvents) => {
        const caches = freshCaches();
        let state = makeInitialState();

        // Renderer receives a full snapshot (cloned over IPC).
        for (const event of seedEvents) {
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );
        }
        let rendererTranscript: readonly TranscriptMessage[] = transcriptOf(caches).map(cloneTranscriptMessage);
        let lastPublished: PublishedTranscriptSnapshot = {
          workspaceId: TARGET_WORKSPACE_ID,
          sessionId: TARGET_SESSION_ID,
          items: transcriptOf(caches),
        };

        for (const event of laterEvents) {
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );

          const current = {
            workspaceId: TARGET_WORKSPACE_ID,
            sessionId: TARGET_SESSION_ID,
            items: transcriptOf(caches),
          };
          const delivery = decideTranscriptDelivery(lastPublished, current);
          if (delivery.kind === "full") {
            rendererTranscript = current.items.map(cloneTranscriptMessage);
            lastPublished = current;
            continue;
          }
          if (delivery.ops.length === 0) {
            continue;
          }

          const ops = delivery.ops as readonly TranscriptDeltaOp[];
          const touchedIds = new Set<string>();
          for (const op of ops) {
            if (op.kind === "upsert") {
              touchedIds.add(op.item.id);
            } else {
              touchedIds.add(op.id);
            }
          }

          const before = rendererTranscript;
          const after = applyTranscriptDelta(before, ops);
          rendererTranscript = after;

          const beforeById = new Map(before.map((item, index) => [item.id, index]));
          const afterById = new Map(after.map((item, index) => [item.id, index]));
          for (const [id, afterIndex] of afterById) {
            if (touchedIds.has(id)) {
              continue;
            }
            const beforeIndex = beforeById.get(id);
            assert.notEqual(beforeIndex, undefined, `untouched item ${id} must still exist`);
            assert.equal(
              after[afterIndex],
              before[beforeIndex!],
              `untouched item ${id} must keep its object identity across applyTranscriptDelta`,
            );
          }
        }
      },
    ),
    { numRuns: 60 },
  );
});

test("memo comparator: content-equal items compare equal without stringify; changes compare unequal", async () => {
  // Direct semantics of sameDisplayItemContent for plain transcript rows:
  // identical content (even fresh objects) → true (no re-render); any content
  // difference → false (re-render). The delta protocol guarantees unchanged
  // items are ALSO reference-identical, so this is the fallback that only runs
  // for actually-replaced rows.
  await fc.assert(
    fc.asyncProperty(
      fc.array(deltaEventArb, { minLength: 5, maxLength: 60 }),
      async (seedEvents) => {
        const caches = freshCaches();
        let state = makeInitialState();
        for (const event of seedEvents) {
          driveEvent(caches, event);
          state = applySessionEventState(
            state,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );
        }
        for (const item of transcriptOf(caches)) {
          const clone = cloneTranscriptMessage(item);
          assert.ok(
            sameDisplayItemContent(item, clone),
            `same content must compare equal for ${item.id} (${item.kind})`,
          );
          assert.ok(
            sameDisplayItemContent(item, item),
            `identical reference must compare equal for ${item.id} (${item.kind})`,
          );
        }
      },
    ),
    { numRuns: 60 },
  );
});
