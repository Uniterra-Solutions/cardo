/**
 * Cardo PBT: the frontend↔backend streaming sync contract.
 *
 * Investigation target — reported bug:
 *   "frontend agent output speed is far below the backend; on long tasks the
 *   agent finishes but the UI keeps showing 'running' and slowly replays the
 *   work."
 *
 * Pipeline under test (mirrors electron/app-store.ts handleSessionEvent + the
 * main.ts publish path, using the compiled pure modules):
 *
 *   driver event (ONE per text delta — see pi-sdk-driver session-supervisor
 *   mapAgentEvent: message_update(text_delta) → assistantDelta) →
 *     appendAssistantDelta / appendThinkingDelta → transcriptCache
 *     applyTimelineEvent → transcriptCache + runtime maps
 *     applySessionEventState → DesktopAppState (session status/preview)
 *     renderer delivery: selected-transcript payload = cache clone
 *     (buildSelectedTranscriptRecord), state payload = structuredClone(state)
 *
 * Invariants of the sync contract:
 *  A. No-loss / no-dup content accounting — the sum of all assistantDelta
 *     texts must equal the sum of all assistant-message texts in the final
 *     transcript (same for thinking deltas). A dropped or duplicated delta is
 *     wrong content in the UI.
 *  B. Item-identity stability — once a transcript item exists, its id and kind
 *     never change and message/thinking text only grows. React keys rows by id;
 *     an id change remounts the row, discarding the measured-height cache and
 *     defeating virtualization.
 *  C. Payload monotonicity — each published transcript payload extends the
 *     previous one (same ids, prefix text growth, items only appended, except
 *     the single documented "Working…" activity removal). A regression would
 *     make the UI show stale content after newer content.
 *  D. Liveness — the invariant the reported symptom violates: the work the
 *     main process does to deliver one more delta must be bounded by a constant
 *     independent of how many deltas were already delivered. If per-delta cost
 *     grows with transcript length, total delivery cost is quadratic in delta
 *     count, and the UI falls irrecoverably behind the backend on long tasks
 *     (agent finishes; UI still chewing through the backlog).
 *
 * A/B/C lock the content contract; D locks the fix: window pushes are coalesced
 * (electron/stream-publish.ts, wired in main.ts) to at most one per wall-clock
 * interval, always carrying the latest state, so the renderer's work is bounded
 * by wall-clock windows (O(windows × transcript)) instead of event count
 * (O(events × transcript)); the renderer additionally memoizes unchanged rows
 * (conversation-timeline.tsx) so each snapshot only re-renders changed rows.
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
} from "../../out-pbt/desktop/electron/app-store-timeline.js";
import { applySessionEventState } from "../../out-pbt/desktop/electron/app-store-session-state.js";
import { cloneTranscriptMessage } from "../../out-pbt/desktop/electron/app-store-utils.js";
import {
  decideStreamPublish,
  STREAM_PUBLISH_INTERVAL_MS,
} from "../../out-pbt/desktop/electron/stream-publish.js";
import { createEmptyDesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import type { DesktopAppState, TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";

/* ── fixed target session ───────────────────────────────── */

const TARGET_WORKSPACE_ID = "sync-ws";
const TARGET_SESSION_ID = "sync-session";
const TARGET_SESSION_REF: SessionRef = { workspaceId: TARGET_WORKSPACE_ID, sessionId: TARGET_SESSION_ID };
const KEY = sessionKey(TARGET_SESSION_REF);

/* ── caches + the real flow driver (mirrors app-store) ──── */

interface FlowCaches {
  transcriptCache: Map<string, TranscriptMessage[]>;
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
        name: "sync workspace",
        path: "/tmp/sync-ws",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        kind: "primary",
        sessions: [
          {
            id: TARGET_SESSION_ID,
            title: "sync session",
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
  workspace: fc.constant({ workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/sync-ws" }),
  title: fc.string({ minLength: 1, maxLength: 40 }),
  status: fc.constantFrom("idle" as const, "running" as const, "failed" as const),
  updatedAt: tsArb,
  archivedAt: fc.option(tsArb, { nil: undefined }),
  preview: fc.option(fc.string(), { nil: undefined }),
  config: fc.constant(undefined),
  runningRunId: fc.option(fc.uuid(), { nil: undefined }),
  queuedMessages: fc.constant([] as never[]),
});

const syncEventArb: fc.Arbitrary<SessionDriverEvent> = fc.oneof(
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

/* ── transcript helpers ─────────────────────────────────── */

function transcriptOf(caches: FlowCaches): TranscriptMessage[] {
  return caches.transcriptCache.get(KEY) ?? [];
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

/** The payload the main process ships to the renderer per event (buildSelectedTranscriptRecord). */
function rendererPayloadBytes(caches: FlowCaches): number {
  return JSON.stringify(transcriptOf(caches).map(cloneTranscriptMessage)).length;
}

function stateBytes(state: DesktopAppState): number {
  return JSON.stringify(state).length;
}

/* ── A. no-loss / no-dup content accounting ─────────────── */

test("content accounting: every delivered delta text lands in the transcript exactly once", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(syncEventArb, { maxLength: 60 }), async (events) => {
      const caches = freshCaches();
      let state = makeInitialState();
      let deliveredAssistantChars = 0;
      let deliveredThinkingChars = 0;

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
      }

      assert.equal(
        assistantTextTotal(transcriptOf(caches)),
        deliveredAssistantChars,
        "assistant delta text must be preserved exactly (no loss, no duplication)",
      );
      assert.equal(
        thinkingTextTotal(transcriptOf(caches)),
        deliveredThinkingChars,
        "thinking delta text must be preserved exactly (no loss, no duplication)",
      );
    }),
    { numRuns: 60 },
  );
});

/* ── B. item-identity stability ─────────────────────────── */

test("identity: ids and kinds are stable, message/thinking text only grows, no ids vanish", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(syncEventArb, { maxLength: 60 }), async (events) => {
      const caches = freshCaches();
      let state = makeInitialState();

      // id -> { kind, text } seen in the PREVIOUS step (text for message/thinking).
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

        const transcript = transcriptOf(caches);
        const idsNow = new Set<string>();
        for (const item of transcript) {
          idsNow.add(item.id);
          const previous = previousById.get(item.id);
          if (!previous) {
            continue;
          }
          assert.equal(
            item.kind,
            previous.kind,
            `item ${item.id} must never change kind (was ${previous.kind}, now ${item.kind})`,
          );
          if (item.kind === "message" || item.kind === "thinking") {
            const text = (item as { text: string }).text;
            assert.ok(
              text.startsWith(previous.text),
              `item ${item.id} text must only grow (${previous.text.length} → ${text.length})`,
            );
          }
        }

        // The only permitted disappearance is the "Working…" activity on completion events.
        for (const [id, previous] of previousById) {
          if (idsNow.has(id)) {
            continue;
          }
          assert.equal(
            id,
            workingActivityIdBefore,
            `item ${id} (${previous.kind}) must never vanish from the transcript`,
          );
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
    { numRuns: 60 },
  );
});

/* ── C. payload monotonicity ────────────────────────────── */

test("payload: each renderer snapshot extends the previous one (never regresses)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(syncEventArb, { maxLength: 60 }), async (events) => {
      const caches = freshCaches();
      let state = makeInitialState();
      let previousPayload: TranscriptMessage[] | null = null;

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

        const payload = transcriptOf(caches).map(cloneTranscriptMessage);
        if (previousPayload) {
          const previousById = new Map(
            previousPayload.map((item) => [item.id, item as unknown as { kind: string; text?: string }]),
          );
          const payloadIds = new Set(payload.map((item) => item.id));
          for (const item of previousPayload) {
            if (!payloadIds.has(item.id)) {
              assert.equal(
                item.id,
                workingActivityIdBefore,
                `payload id ${item.id} must not regress (only the Working… activity may be removed)`,
              );
            }
          }
          for (const item of payload) {
            const previous = previousById.get(item.id);
            if (!previous) {
              continue;
            }
            assert.equal(item.kind, previous.kind, `payload item ${item.id} must keep its kind`);
            if (item.kind === "message" || item.kind === "thinking") {
              assert.ok(
                (item as { text: string }).text.startsWith(previous.text ?? ""),
                `payload item ${item.id} text must never shrink`,
              );
            }
          }
        }
        previousPayload = payload;
      }
    }),
    { numRuns: 60 },
  );
});

/* ── D. liveness: per-delta delivery cost must be bounded ── */

/**
 * A realistic streaming run: a few thousand deltas with interleaved tool
 * results (the transcript grows to realistic size, as in a long agent task).
 * Builds the exact payloads the main process ships per event and measures how
 * much data is copied per delivered delta.
 */
function simulateRun(eventCount: number, opts: { toolOutputEvery?: number; toolOutputSize?: number } = {}): {
  events: SessionDriverEvent[];
  totalCopyWork: number;
  totalDeltaBytes: number;
  perEventCopy: number[];
} {
  const { toolOutputEvery = 10, toolOutputSize = 4_000 } = opts;
  const caches = freshCaches();
  let state = makeInitialState();
  const events: SessionDriverEvent[] = [];
  const baseTs = Date.parse("2026-06-01T00:00:00.000Z");

  let toolIndex = 0;
  for (let i = 0; i < eventCount; i += 1) {
    const timestamp = new Date(baseTs + i * 10).toISOString();
    if (i % toolOutputEvery === toolOutputEvery - 1) {
      toolIndex += 1;
      const callId = `call-${toolIndex}`;
      events.push({
        type: "toolStarted",
        sessionRef: TARGET_SESSION_REF,
        timestamp,
        toolName: "read",
        callId,
        input: { path: `/tmp/sync-ws/src/file-${toolIndex}.ts` },
      });
      events.push({
        type: "toolFinished",
        sessionRef: TARGET_SESSION_REF,
        timestamp,
        callId,
        success: true,
        output: `export const value = "${"x".repeat(toolOutputSize)}";`,
      });
      continue;
    }
    if (i % 7 === 0) {
      events.push({
        type: "assistantThinkingDelta",
        sessionRef: TARGET_SESSION_REF,
        timestamp,
        text: `thinking step ${i} `.repeat(2),
      });
      continue;
    }
    // Assistant text delta (the per-token stream).
    events.push({
      type: "assistantDelta",
      sessionRef: TARGET_SESSION_REF,
      timestamp,
      text: `delta ${i} `.repeat(1),
    });
  }
  // Finish the run so the final state is a completed (idle) session.
  events.push({
    type: "runCompleted",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs + eventCount * 10).toISOString(),
    snapshot: {
      ref: TARGET_SESSION_REF,
      workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/sync-ws" },
      title: "sync session",
      status: "idle",
      updatedAt: new Date(baseTs + eventCount * 10).toISOString(),
      queuedMessages: [],
    } as never,
  });

  const perEventCopy: number[] = [];
  let totalDeltaBytes = 0;
  for (const event of events) {
    driveEvent(caches, event);
    state = applySessionEventState(
      state,
      event,
      caches.transcriptCache,
      caches.runningSinceBySession,
      caches.lastViewedAtBySession,
    );
    // What the main process ships per event: state payload + transcript payload.
    const shipped = stateBytes(state) + rendererPayloadBytes(caches);
    perEventCopy.push(shipped);
    totalDeltaBytes +=
      event.type === "assistantDelta" || event.type === "assistantThinkingDelta" ? event.text.length : 0;
  }

  return { events, totalCopyWork: perEventCopy.reduce((a, b) => a + b, 0), totalDeltaBytes, perEventCopy };
}

/* ── D. liveness: window pushes are coalesced, rate bounded by wall clock ── */

/**
 * Discrete-event model of createCoalescedPublisher (main.ts window delivery):
 * schedule() is called once per event with the event's wall-clock time; pushes
 * are leading-edge (idle events) or trailing-edge (≤ interval later, always
 * carrying the latest state). Deterministic — no timers.
 */
interface SchedulerSim {
  readonly pushTimes: number[];
  readonly lastPushAt: number | null;
}

function simulateCoalescedScheduler(eventTimes: readonly number[], intervalMs: number): SchedulerSim {
  let pending = false;
  let lastRunAt = 0;
  let pendingFireAt: number | null = null;
  const pushTimes: number[] = [];
  const ship = (at: number) => {
    pushTimes.push(at);
    lastRunAt = at;
    pending = false;
    pendingFireAt = null;
  };
  for (const at of eventTimes) {
    if (pendingFireAt !== null && at >= pendingFireAt) {
      ship(pendingFireAt);
    }
    const decision = decideStreamPublish({ pending, lastRunAt }, intervalMs, at);
    if (decision.kind === "publish-now") {
      ship(at);
    } else if (decision.kind === "schedule") {
      pending = true;
      pendingFireAt = at + decision.delayMs;
    }
  }
  if (pendingFireAt !== null) {
    ship(pendingFireAt);
  }
  return { pushTimes, lastPushAt: pushTimes.length > 0 ? (pushTimes[pushTimes.length - 1] ?? null) : null };
}

/** Monotonically increasing event times over a realistic task duration. */
const eventTimesArb = fc
  .integer({ min: 10, max: 300 })
  .chain((eventCount) =>
    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: eventCount, maxLength: eventCount }).map((gaps) => {
      const times: number[] = [];
      let at = 10_000;
      for (const gap of gaps) {
        at += gap;
        times.push(at);
      }
      return times;
    }),
  );

test("liveness: pushes are at most one per interval and the final event is always delivered (no backlog, no starvation)", () => {
  const interval = STREAM_PUBLISH_INTERVAL_MS;
  fc.assert(
    fc.property(eventTimesArb, (times) => {
      const { pushTimes, lastPushAt } = simulateCoalescedScheduler(times, interval);
      assert.ok(pushTimes.length > 0, "a non-empty event stream must produce at least one push");

      // (a) rate bound: consecutive pushes are ≥ interval apart (except the first
      // push, which is leading-edge) — the renderer never receives more than one
      // full-transcript snapshot per interval, however fast events arrive.
      for (let index = 1; index < pushTimes.length; index += 1) {
        const gap = (pushTimes[index] ?? 0) - (pushTimes[index - 1] ?? 0);
        assert.ok(
          gap >= interval,
          `push gap ${gap}ms < interval ${interval}ms between pushes ${pushTimes[index - 1]} and ${pushTimes[index]}`,
        );
      }

      // (b) no starvation: the final event is delivered by the trailing edge
      // within one interval — the UI must not sit on a stale state after the
      // backend finishes.
      const lastEvent = times[times.length - 1] ?? 0;
      assert.ok(
        lastPushAt !== null && lastPushAt >= lastEvent && lastPushAt <= lastEvent + interval,
        `final event at ${lastEvent} must be pushed within ${interval}ms (last push: ${lastPushAt})`,
      );

      // (c) rate is independent of event count: the push count over a given
      // duration is bounded by wall-clock windows, not by how many events arrive.
      // (+2: one leading-edge push at the first event, and the final trailing
      // push up to one interval after the last event.)
      const duration = Math.max(0, lastEvent - (times[0] ?? 0));
      const bound = Math.ceil(duration / interval) + 2;
      assert.ok(
        pushTimes.length <= bound,
        `${pushTimes.length} pushes for ${times.length} events over ${duration}ms exceeds the wall-clock bound ${bound}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("liveness (end-to-end): coalesced delivery ships O(windows × transcript) bytes, not O(events × transcript)", () => {
  // Drive the real pipeline over a realistic long task, then count how many
  // full-transcript payloads the coalesced window delivery would actually ship
  // (one per push). Without coalescing this is one shipment per event and the
  // renderer falls behind the backend; with it the shipment count is bounded by
  // wall-clock windows and the final transcript is always among the shipments.
  const interval = STREAM_PUBLISH_INTERVAL_MS;
  fc.assert(
    fc.property(fc.integer({ min: 40, max: 600 }), (eventCount) => {
      const { events, perEventCopy } = simulateRun(eventCount);
      const eventTimes = events.map((event) => Date.parse(event.timestamp));
      const { pushTimes } = simulateCoalescedScheduler(eventTimes, interval);
      const uncoalescedBytes = perEventCopy.reduce((a, b) => a + b, 0);
      const coalescedBytes = pushTimes.length * Math.max(...perEventCopy);
      assert.ok(
        pushTimes.length < events.length,
        `coalescing must ship fewer payloads than events: ${pushTimes.length} pushes vs ${events.length} events`,
      );
      assert.ok(
        coalescedBytes <= uncoalescedBytes,
        `coalesced delivery (${coalescedBytes} bytes) must not exceed uncoalesced (${uncoalescedBytes} bytes)`,
      );
    }),
    { numRuns: 20 },
  );
});

/* ── deterministic scaling report (diagnostic, not a pass/fail gate) ── */

test("scaling report: uncoalesced per-event payload vs coalesced push count", () => {
  const { events, perEventCopy } = simulateRun(400, { toolOutputEvery: 8, toolOutputSize: 2_000 });
  const eventTimes = events.map((event) => Date.parse(event.timestamp));
  const { pushTimes } = simulateCoalescedScheduler(eventTimes, STREAM_PUBLISH_INTERVAL_MS);
  // Sample the per-event payloads at growing transcript lengths to expose the
  // linear-in-length per-event cost the coalescer removes (O(events²) → O(windows)).
  const samples = [0, 49, 99, 199, 299, perEventCopy.length - 1]
    .filter((index) => index >= 0 && index < perEventCopy.length);
  const report = samples
    .map((index) => `event ${index + 1}/${perEventCopy.length}: uncoalesced=${perEventCopy[index]} bytes`)
    .join("\n  ");
  // eslint-disable-next-line no-console
  console.log(
    `\n  [streaming-sync] payload per event (uncoalesced) vs coalesced pushes:\n  ${report}\n` +
      `  coalesced: ${perEventCopy.length} events → ${pushTimes.length} pushes ` +
      `(max payload ${Math.max(...perEventCopy)} bytes each)`,
  );
  assert.ok(perEventCopy.length > 0);
});
