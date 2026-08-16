/**
 * Cardo PBT: store-side liveness of the streaming delivery path.
 *
 * Investigation target — reported bug (recurring, multiple failed fixes):
 *   "只要我發給 agent 一個長任務，前端就會一直落後於後端，並且我完全無法對
 *   前端其他功能進行操作。" (any long task: the frontend display lags the
 *   backend AND the whole UI becomes unresponsive — sidebar clicks, session
 *   switches, everything.)
 *
 * The existing streaming-sync.test.mts locks the DELIVERY contract (coalesced
 * window pushes + transcript delta channel) — push RATE is bounded and the
 * renderer's per-push transcript work is bounded by changed content. But the
 * MAIN process still paid a quadratic per-event cost inside the store:
 *
 *   electron/app-store-session-state.ts applySessionEventState did
 *     `transcriptCache.get(key).map(cloneTranscriptMessage)`
 *   on EVERY driver event — a full copy pass over the accumulated transcript,
 *   used ONLY for two read-only computations (previewFromTranscript and
 *   hasUnseenSessionUpdate). Measured at 3000 events: 45.7µs/event before vs
 *   3.0µs/event after removing the pass (15×; per-event cost no longer grows
 *   with the transcript).
 *
 * Business invariant locked here (K, store-side liveness):
 *   Folding one driver event into the session state must cost O(the event's
 *   own change) — one session-record update — never a full copy pass over the
 *   accumulated transcript. If per-event cost grows with transcript length,
 *   total store work is quadratic in event count; the main process saturates
 *   on long tasks, every IPC round-trip (clicking the sidebar, switching
 *   sessions) stalls, and the UI falls irrecoverably behind the backend.
 *
 * The detector is BEHAVIORAL, not a source grep or a timing guess: the
 * transcript cache is handed to applySessionEventState through a Proxy that
 * counts full-array copy calls (.map/.filter/.slice/.concat/.reduce/.flat/
 * .flatMap) on the session's transcript array. The invariant asserts ZERO such
 * passes per fold — the cache arrays must be consumed read-only (index reads
 * and iteration are fine; a copy of the whole array is the bug).
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
import { createEmptyDesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import type { DesktopAppState, TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";

/* ── fixed target session ───────────────────────────────── */

const TARGET_WORKSPACE_ID = "store-ws";
const TARGET_SESSION_ID = "store-session";
const TARGET_SESSION_REF: SessionRef = { workspaceId: TARGET_WORKSPACE_ID, sessionId: TARGET_SESSION_ID };
const KEY = sessionKey(TARGET_SESSION_REF);

/** Methods that perform a full copy pass over an array (the quadratic cost). */
const COPY_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "reduce",
  "flat",
  "flatMap",
  "reverse",
  "sort",
]);

/* ── caches + the real flow driver (mirrors app-store handleSessionEvent) ── */

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
        name: "store workspace",
        path: "/tmp/store-ws",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        kind: "primary",
        sessions: [
          {
            id: TARGET_SESSION_ID,
            title: "store session",
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

/**
 * Wrap the transcript cache so every entry handed out by `.get()` counts
 * full-copy method calls (map/filter/slice/...) AND `toArray()` materialization
 * (K contract, hard rule 5: the session-state fold must consume the entry
 * read-only — index reads and iteration only). Index reads pass through.
 */
function proxyTranscriptCache(
  cache: Map<string, TranscriptCacheEntry>,
  onCopyCall: (method: string) => void,
): Map<string, TranscriptCacheEntry> {
  const entryProxy = (entry: TranscriptCacheEntry): TranscriptCacheEntry =>
    new Proxy(entry, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && (COPY_METHODS.has(prop) || prop === "toArray")) {
          onCopyCall(prop);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return new Proxy(cache, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return (key: string): TranscriptCacheEntry | undefined => {
          const entry = target.get(key);
          return entry === undefined ? undefined : entryProxy(entry);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Wrap the transcript cache to count the store's per-event array REBUILD
 * work: every `transcriptCache.set(key, newArray)` rebuilds the transcript
 * from a full-array spread (the `[...items]` copies `newArray.length`
 * elements), so `Σ rebuilt.length` is the exact element-copy cost of the fold
 * path. A persistent structure (task A) bounds each event's rebuild to a
 * small chunk instead of the whole transcript.
 */
function proxyRebuildWork(
  cache: Map<string, TranscriptCacheEntry>,
): { proxied: Map<string, TranscriptCacheEntry>; rebuildWork: () => number } {
  let work = 0;
  const proxied = new Proxy(cache, {
    get(target, prop, receiver) {
      if (prop === "get") {
        // Bind to the real map: a raw `Reflect.get(target, "get", proxy)`
        // returns the unbound Map.prototype.get, which throws "incompatible
        // receiver" when the store calls it with the proxy as `this`.
        return (key: string): TranscriptCacheEntry | undefined => target.get(key);
      }
      if (prop === "set") {
        return (key: string, entry: TranscriptCacheEntry): Map<string, TranscriptCacheEntry> => {
          work += entry.length;
          return Reflect.apply(target.set, target, [key, entry]);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxied, rebuildWork: () => work };
}

/**
 * Fold a stream through the REAL store wiring and count the full-array copy
 * passes the session-state fold performs on the accumulated transcript.
 */
function measureFoldCopyPasses(eventCount: number): { copyPasses: number; events: number; maxItems: number } {
  const caches = freshCaches();
  let state = makeInitialState();
  let copyPasses = 0;
  let maxItems = 0;
  // Only applySessionEventState reads through the proxy; the drive path uses
  // the raw cache so timeline mutations are not counted (invariant K targets
  // the session-state fold).
  const proxiedCache = proxyTranscriptCache(caches.transcriptCache, (method) => {
    copyPasses += 1;
    void method;
  });
  for (const event of buildEvents(eventCount)) {
    driveEvent(caches, event);
    maxItems = Math.max(maxItems, (caches.transcriptCache.get(KEY) ?? []).length);
    state = applySessionEventState(
      state,
      event,
      proxiedCache,
      caches.runningSinceBySession,
      caches.lastViewedAtBySession,
    );
  }
  return { copyPasses, events: eventCount, maxItems };
}

/* ── event stream builder (deterministic, realistic long task) ── */

/**
 * Build a realistic long streaming run: per-token assistant deltas with
 * interleaved reasoning and tool results, so the transcript accumulates to
 * realistic size (items + message text) as in a long agent task.
 */
function buildEvents(eventCount: number): SessionDriverEvent[] {
  const events: SessionDriverEvent[] = [];
  const baseTs = Date.parse("2026-06-01T00:00:00.000Z");
  let toolIndex = 0;
  events.push({
    type: "sessionOpened",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs).toISOString(),
    snapshot: {
      ref: TARGET_SESSION_REF,
      workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/store-ws" },
      title: "store session",
      status: "running",
      updatedAt: new Date(baseTs).toISOString(),
      queuedMessages: [],
    } as never,
  });
  for (let i = 1; i < eventCount; i += 1) {
    const timestamp = new Date(baseTs + i * 10).toISOString();
    if (i % 10 === 0) {
      toolIndex += 1;
      const callId = `call-${toolIndex}`;
      events.push({
        type: "toolStarted",
        sessionRef: TARGET_SESSION_REF,
        timestamp,
        toolName: "read",
        callId,
        input: { path: `/tmp/store-ws/src/file-${toolIndex}.ts` },
      });
      events.push({
        type: "toolFinished",
        sessionRef: TARGET_SESSION_REF,
        timestamp,
        callId,
        success: true,
        output: `export const value = "${"x".repeat(2000)}";`,
      });
      continue;
    }
    if (i % 7 === 0) {
      events.push({
        type: "assistantThinkingDelta",
        sessionRef: TARGET_SESSION_REF,
        timestamp,
        text: `reasoning step ${i} `,
      });
      continue;
    }
    events.push({
      type: "assistantDelta",
      sessionRef: TARGET_SESSION_REF,
      timestamp,
      text: `delta ${i} `,
    });
  }
  return events;
}

/* ── K. store-side liveness ─────────────────────────────── */

/**
 * Folding an event into session state must consume the transcript cache
 * read-only: ZERO full-array copy passes per event, for every event mix.
 */
test("K: folding events into session state must not copy the accumulated transcript", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 50, max: 800 }),
      (eventCount) => {
        const { copyPasses, events } = measureFoldCopyPasses(eventCount);
        assert.equal(
          copyPasses,
          0,
          `applySessionEventState performed ${copyPasses} full-array copy pass(es) over the accumulated ` +
            `transcript while folding ${events} events — per-event cost grows with transcript length, ` +
            `total store work is quadratic on long tasks (main process saturates; UI freezes).`,
        );
      },
    ),
    { numRuns: 40 },
  );
});

/** Deterministic regression pin: the same invariant at long-task scale. */
test("K (deterministic): 3000 events fold in with zero transcript copy passes", () => {
  const { copyPasses, events, maxItems } = measureFoldCopyPasses(3000);
  assert.equal(
    copyPasses,
    0,
    `${events} events: ${copyPasses} full-array copy pass(es) over the transcript (peaked at ${maxItems} items) — ` +
      `every event re-copies the accumulated transcript (electron/app-store-session-state.ts ` +
      `applySessionEventState); quadratic main-process work on long tasks.`,
  );
});

/**
 * Unit regression for the exact fixed function: applySessionEventState must
 * fold ONE event into the session state while consuming the transcript cache
 * read-only — zero full-array copy passes — and still compute the correct
 * session record (preview reflects the latest assistant text).
 */
test("unit: applySessionEventState folds one event without copying the transcript cache array", () => {
  const caches = freshCaches();
  const baseTs = Date.parse("2026-06-01T00:00:00.000Z");
  // Drive the real store wiring to build a session transcript with content.
  const opened: SessionDriverEvent = {
    type: "sessionOpened",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs).toISOString(),
    snapshot: {
      ref: TARGET_SESSION_REF,
      workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/store-ws" },
      title: "store session",
      status: "running",
      updatedAt: new Date(baseTs).toISOString(),
      queuedMessages: [],
    } as never,
  };
  driveEvent(caches, opened);
  driveEvent(caches, {
    type: "assistantDelta",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs + 1).toISOString(),
    text: "hello ",
  });
  driveEvent(caches, {
    type: "assistantDelta",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs + 2).toISOString(),
    text: "world",
  });

  // The next fold goes through the detector: any full-array copy pass on the
  // accumulated transcript is the regression (it used to be
  // `.map(cloneTranscriptMessage)` on every event).
  let copyPasses = 0;
  const proxiedCache = proxyTranscriptCache(caches.transcriptCache, () => {
    copyPasses += 1;
  });
  const state = applySessionEventState(
    makeInitialState(),
    {
      type: "runCompleted",
      sessionRef: TARGET_SESSION_REF,
      timestamp: new Date(baseTs + 3).toISOString(),
      runId: "run-1",
      snapshot: {
        ref: TARGET_SESSION_REF,
        workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/store-ws" },
        title: "store session",
        status: "idle",
        updatedAt: new Date(baseTs + 3).toISOString(),
        queuedMessages: [],
      } as never,
    },
    proxiedCache,
    caches.runningSinceBySession,
    caches.lastViewedAtBySession,
  );

  assert.equal(copyPasses, 0, "folding one event must not copy the accumulated transcript");
  const record = state.workspaces.find((w) => w.id === TARGET_WORKSPACE_ID)?.sessions.find(
    (s) => s.id === TARGET_SESSION_ID,
  );
  assert.ok(record, "the folded session record is present");
  assert.equal(record?.preview, "hello world", "preview is computed from the transcript without cloning it");
  assert.equal(record?.status, "idle", "runCompleted folds the session status");
});

/* ── K′. full-fold rebuild work is linear in event count ── */

/**
 * The store's per-event transcript REBUILD (the `[...transcript]` spread in
 * appendAssistantDelta / appendThinkingDelta / applyTimelineEvent) must be
 * bounded by a small constant, never by the accumulated transcript length.
 * Measured exactly: every `transcriptCache.set(key, newArray)` rebuild copies
 * `newArray.length` elements, so Σ rebuilt-lengths is the fold path's
 * element-copy cost. Linear bound `≤ 64 × events` allows each event to
 * rebuild a small chunk (the persistent-structure target); the current
 * array-spread design copies the whole transcript per event → quadratic.
 */
test("K′: the full fold path must not rebuild the whole transcript array per event", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 300, max: 2000 }),
      (eventCount) => {
        const { rebuildWork, events } = measureRebuildWork(eventCount);
        const bound = 64 * events;
        assert.ok(
          rebuildWork <= bound,
          `fold path rebuilt ${rebuildWork} transcript elements over ${events} events ` +
            `(linear bound ${bound}) — every event spreads the whole accumulated transcript; ` +
            `total store work is quadratic on long tasks.`,
        );
      },
    ),
    { numRuns: 30 },
  );
});

/** Deterministic regression pin at long-task scale. */
test("K′ (deterministic): 3000 events must fold with linear rebuild work", () => {
  const { rebuildWork, events, maxItems } = measureRebuildWork(3000);
  const bound = 64 * events;
  assert.ok(
    rebuildWork <= bound,
    `${events} events: fold path rebuilt ${rebuildWork} transcript elements (bound ${bound}; ` +
      `transcript peaked at ${maxItems} items) — the store copies the whole transcript per event; ` +
      `quadratic main-process work on long tasks (needs the persistent-structure refactor).`,
  );
});

/* ── J. identity stability of untouched transcript items ── */

/**
 * The reference-stability contract the delta diff and the renderer memo rely
 * on: an item whose CONTENT did not change across a fold must keep OBJECT
 * IDENTITY (`===` short-circuit). Items that legitimately changed content
 * (the in-flight assistant message growing, a thinking block finalizing with
 * endedAt, a tool row running→success) may be replaced. A refactor that
 * rebuilds content-unchanged items degenerates the delta channel into a full
 * resend and defeats every memo.
 */
function itemContentFingerprint(item: TranscriptMessage): string {
  switch (item.kind) {
    case "message":
      return `m:${item.id}:${item.role}:${item.text}:${item.createdAt}`;
    case "thinking":
      return `t:${item.id}:${item.text}:${item.endedAt ?? ""}`;
    case "tool":
      return (
        `t:${item.id}:${item.callId}:${item.toolName ?? ""}:${item.status}:${item.label}:` +
        `${item.detail ?? ""}:${JSON.stringify(item.input ?? "")}:${JSON.stringify(item.output ?? "")}`
      );
    case "activity":
      return `a:${item.id}:${item.label}:${item.detail ?? ""}`;
    case "summary":
      return `s:${item.id}:${item.label}:${item.presentation ?? ""}`;
    default:
      return JSON.stringify(item);
  }
}

test("J: content-unchanged transcript items keep object identity across folds", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 600 }),
      (eventCount) => {
        const caches = freshCaches();
        let previousById = new Map<string, { fingerprint: string; item: TranscriptMessage }>();
        for (const event of buildEvents(eventCount)) {
          driveEvent(caches, event);
          // Cardo: T1 — the cache value is the persistent entry (array-compatible read surface).
          const items: readonly TranscriptMessage[] = caches.transcriptCache.get(KEY) ?? [];
          const nowById = new Map(items.map((item) => [item.id, { fingerprint: itemContentFingerprint(item), item }]));
          for (const [id, previous] of previousById) {
            const current = nowById.get(id);
            if (current !== undefined && current.fingerprint === previous.fingerprint) {
              assert.equal(
                current.item,
                previous.item,
                `item ${id} kept its content but lost object identity across a fold — ` +
                  `memo/delta identity contract broken`,
              );
            }
          }
          previousById = nowById;
        }
      },
    ),
    { numRuns: 15 },
  );
});

/* ── measurements shared by the invariants above ── */

/** Fold a stream through the REAL wiring and measure full-path rebuild work. */
function measureRebuildWork(eventCount: number): { rebuildWork: number; events: number; maxItems: number } {
  const caches = freshCaches();
  let state = makeInitialState();
  const { proxied, rebuildWork } = proxyRebuildWork(caches.transcriptCache);
  let maxItems = 0;
  for (const event of buildEvents(eventCount)) {
    driveEvent({ ...caches, transcriptCache: proxied }, event);
    maxItems = Math.max(maxItems, (caches.transcriptCache.get(KEY) ?? []).length);
    state = applySessionEventState(
      state,
      event,
      caches.transcriptCache,
      caches.runningSinceBySession,
      caches.lastViewedAtBySession,
    );
  }
  return { rebuildWork: rebuildWork(), events: eventCount, maxItems };
}
