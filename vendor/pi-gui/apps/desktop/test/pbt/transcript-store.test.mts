/**
 * Cardo: PBT — TranscriptCacheEntry, the persistent transcript structure.
 *
 * Real-time streaming refactor (T1): the transcript cache value changed from a
 * plain array (rebuilt from `[...transcript]` on every driver event) to a
 * chunked persistent list. This suite locks the entry's contract:
 *
 *  - append / replaceById / removeById semantics (content + order), with the
 *    O(1) id index (findById never materializes the list — asserted through a
 *    copy-access Proxy, the same behavioral technique as invariant K).
 *  - chunk rolling at TRANSCRIPT_CHUNK_SIZE (mutation cost is bounded by one
 *    chunk, not the accumulated transcript).
 *  - toArray() reproduces the exact array content and order of the previous
 *    cache arrays (reference-model PBT: entry === model array under arbitrary
 *    mutation sequences).
 *  - J-style identity: content-unchanged items keep object identity across
 *    mutations (the transcript-delta diff and renderer memo rely on `===`).
 *  - streaming parts: the active assistant message / thinking block text is a
 *    parts list with a rope-cached join; the entry's index accessor returns the
 *    CURRENT joined text while streaming (preview correctness) and the item is
 *    materialized with the joined text at finalize.
 *  - the "Working…" activity row is removed on run completion (the only
 *    permitted removal in the payload-monotonicity contract).
 *  - K′-style budget over the REAL fold path: Σ `transcriptCache.set` lengths
 *    ≤ TRANSCRIPT_CHUNK_SIZE × events (each event rebuilds at most one chunk).
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
  TRANSCRIPT_CHUNK_SIZE,
  TranscriptCacheEntry,
  type ActiveThinkingRecord,
} from "../../out-pbt/desktop/electron/app-store-timeline.js";
import {
  makeActivityItem,
  makeThinkingItem,
  makeToolItem,
  makeTranscriptMessage,
} from "../../out-pbt/desktop/electron/app-store-utils.js";
import type { TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";

/* ── fixed target session + helpers ─────────────────────── */

const TARGET_WORKSPACE_ID = "store-ws";
const TARGET_SESSION_ID = "store-session";
const TARGET_SESSION_REF: SessionRef = { workspaceId: TARGET_WORKSPACE_ID, sessionId: TARGET_SESSION_ID };
const KEY = sessionKey(TARGET_SESSION_REF);

function messageItem(id: string, role: "user" | "assistant", text: string, createdAt: string): TranscriptMessage {
  return { kind: "message", id, role, text, createdAt };
}

/** The copy methods the K harness counts; findById must never trigger any of them. */
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
  "toArray",
]);

/** Wrap an entry so every copy-method/toArray access is counted (behavioral O(1) detector). */
function copyAccessProbe(entry: TranscriptCacheEntry): { proxied: TranscriptCacheEntry; accesses: () => string[] } {
  const accesses: string[] = [];
  const proxied = new Proxy(entry, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && COPY_METHODS.has(prop)) {
        accesses.push(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxied, accesses: () => accesses };
}

/* ── unit: append / replaceById / removeById semantics ──── */

test("unit: append/replaceById/removeById maintain content and order", () => {
  const entry = TranscriptCacheEntry.fromArray([
    messageItem("m1", "user", "one", "2026-01-01T00:00:00.000Z"),
    messageItem("m2", "assistant", "two", "2026-01-01T00:00:01.000Z"),
  ]);
  assert.equal(entry.length, 2);

  entry.append(messageItem("m3", "user", "three", "2026-01-01T00:00:02.000Z"));
  assert.equal(entry.length, 3);
  assert.deepEqual(
    entry.toArray().map((item) => item.id),
    ["m1", "m2", "m3"],
    "append adds at the end",
  );

  entry.replaceById("m2", messageItem("m2", "assistant", "two-v2", "2026-01-01T00:00:01.000Z"));
  assert.deepEqual(
    entry.toArray().map((item) => [item.id, item.kind === "message" ? item.text : ""]),
    [["m1", "one"], ["m2", "two-v2"], ["m3", "three"]],
    "replaceById swaps the item in place (order preserved)",
  );
  assert.equal(entry.length, 3, "replaceById does not change length");

  entry.removeById("m1");
  assert.deepEqual(
    entry.toArray().map((item) => item.id),
    ["m2", "m3"],
    "removeById drops the item and compacts order",
  );
  assert.equal(entry.length, 2);

  entry.removeById("does-not-exist");
  assert.deepEqual(
    entry.toArray().map((item) => item.id),
    ["m2", "m3"],
    "removeById of an unknown id is a no-op",
  );
  assert.equal(entry.findById("m1"), undefined, "removed id is no longer findable");
});

test("unit: findById is O(1) — never materializes or scans the list", () => {
  const entry = TranscriptCacheEntry.empty();
  for (let index = 0; index < 500; index += 1) {
    entry.append(messageItem(`id-${index}`, "user", `text ${index}`, "2026-01-01T00:00:00.000Z"));
  }
  const { proxied, accesses } = copyAccessProbe(entry);
  const found = proxied.findById("id-333");
  assert.ok(found, "findById resolves an existing id");
  assert.equal(found.id, "id-333");
  assert.deepEqual(accesses(), [], "findById must not copy/materialize/scan — O(1) index lookup");
  assert.equal(proxied.findById("missing"), undefined, "unknown id returns undefined");
});

/* ── reference model PBT: toArray() mirrors the prior array semantics ── */

const itemArb: fc.Arbitrary<TranscriptMessage> = fc
  .tuple(fc.uuid(), fc.constantFrom("user" as const, "assistant" as const), fc.string({ maxLength: 20 }))
  .map(([id, role, text]) => messageItem(id, role, text, "2026-01-01T00:00:00.000Z"));

const mutationArb = fc.oneof(
  fc.record({ op: fc.constant("append" as const), item: itemArb }),
  fc.record({
    op: fc.constant("replace" as const),
    id: fc.uuid(),
    item: itemArb,
  }),
  fc.record({
    op: fc.constant("remove" as const),
    id: fc.uuid(),
  }),
);

function sameContent(a: readonly TranscriptMessage[], b: readonly TranscriptMessage[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) {
      return false;
    }
  }
  return true;
}

test("PBT: entry.toArray() equals a reference model array under arbitrary mutations", () => {
  fc.assert(
    fc.property(fc.array(itemArb, { maxLength: 40 }), fc.array(mutationArb, { maxLength: 200 }), (seed, mutations) => {
      const entry = TranscriptCacheEntry.fromArray(seed);
      const model = seed.map((item) => ({ ...item }));

      for (const mutation of mutations) {
        if (mutation.op === "append") {
          entry.append(mutation.item);
          model.push(mutation.item);
        } else if (mutation.op === "replace") {
          const index = model.findIndex((item) => item.id === mutation.id);
          if (index >= 0) {
            entry.replaceById(mutation.id, mutation.item);
            model[index] = mutation.item;
          }
        } else {
          const index = model.findIndex((item) => item.id === mutation.id);
          if (index >= 0) {
            entry.removeById(mutation.id);
            model.splice(index, 1);
          }
        }
        // Invariant: the entry's materialized content always mirrors the model.
        assert.ok(
          sameContent(entry.toArray(), model),
          `toArray diverged from the reference model after ${mutation.op}(${mutation.id ?? mutation.item?.id})`,
        );
        assert.equal(entry.length, model.length, "length tracks the model");
      }
    }),
    { numRuns: 60 },
  );
});

/* ── chunk rolling at TRANSCRIPT_CHUNK_SIZE ─────────────── */

test("unit: chunks roll at TRANSCRIPT_CHUNK_SIZE with full order + lookup integrity", () => {
  const count = TRANSCRIPT_CHUNK_SIZE * 3 + 7;
  const entry = TranscriptCacheEntry.empty();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `roll-${index}`;
    ids.push(id);
    entry.append(messageItem(id, "user", `text ${index}`, "2026-01-01T00:00:00.000Z"));
  }
  assert.equal(entry.length, count);
  assert.deepEqual(
    entry.toArray().map((item) => item.id),
    ids,
    "toArray order spans chunk boundaries correctly",
  );
  for (const id of ids) {
    assert.equal(entry.findById(id)?.id, id, `findById resolves ${id} across chunk boundaries`);
  }
  // Mid-list mutation (last item of the first chunk) must keep everything coherent.
  entry.replaceById("roll-31", messageItem("roll-31", "assistant", "replaced", "2026-01-01T00:00:00.000Z"));
  entry.removeById("roll-0");
  assert.equal(entry.length, count - 1);
  assert.equal(entry.toArray()[0]?.id, "roll-1", "order compacts after a mid-chunk removal");
  assert.equal(entry.findById("roll-63")?.id, "roll-63", "index stays correct across the chunk seam");
});

/* ── J-style identity of untouched items ────────────────── */

test("PBT: content-unchanged items keep object identity across mutations", () => {
  fc.assert(
    fc.property(fc.array(itemArb, { minLength: 5, maxLength: 30 }), fc.array(mutationArb, { maxLength: 60 }), (seed, mutations) => {
      const entry = TranscriptCacheEntry.fromArray(seed);
      const byId = new Map(seed.map((item) => [item.id, item]));

      for (const mutation of mutations) {
        // Snapshot identities before the mutation.
        const before = new Map(entry.toArray().map((item) => [item.id, item]));
        if (mutation.op === "append") {
          entry.append(mutation.item);
          byId.set(mutation.item.id, mutation.item);
        } else if (mutation.op === "replace") {
          if (byId.has(mutation.id)) {
            entry.replaceById(mutation.id, mutation.item);
            byId.set(mutation.id, mutation.item);
          }
        } else {
          if (byId.has(mutation.id)) {
            entry.removeById(mutation.id);
            byId.delete(mutation.id);
          }
        }
        const after = new Map(entry.toArray().map((item) => [item.id, item]));
        for (const [id, previousItem] of before) {
          const currentItem = after.get(id);
          if (currentItem !== undefined) {
            assert.equal(
              currentItem,
              previousItem,
              `item ${id} survived the mutation but lost object identity — the delta diff / memo ` +
                `reference contract depends on it`,
            );
          }
        }
      }
    }),
    { numRuns: 40 },
  );
});

/* ── streaming parts: preview text current while streaming; finalize joins ── */

test("unit: streaming parts — index access shows current text; finalize materializes the joined text", () => {
  const entry = TranscriptCacheEntry.empty();
  const first = makeTranscriptMessage("assistant", "alpha ");
  entry.append(first);
  entry.beginParts(first.id, "alpha ", first);

  // While streaming, the entry's index accessor (preview path) and toArray both
  // expose the CURRENT joined text — never stale, never a per-delta flat join.
  assert.equal(entry[0]!.kind === "message" ? (entry[0] as { text: string }).text : "", "alpha ");
  entry.appendPart(first.id, "beta ");
  assert.equal((entry[0] as { text: string }).text, "alpha beta ");
  entry.appendPart(first.id, "gamma");
  assert.equal((entry[0] as { text: string }).text, "alpha beta gamma");
  assert.equal(entry.toArray()[0]!.kind === "message" ? (entry.toArray()[0] as { text: string }).text : "", "alpha beta gamma");
  assert.equal(entry.findById(first.id)?.kind === "message" ? (entry.findById(first.id) as { text: string }).text : "", "alpha beta gamma");

  // Streaming items are exempt from the J identity contract while their content
  // changes, but the VIEW object is reused between appends (identity stable when
  // text stalls) so the reference-accelerated delta diff never misses growth.
  const viewBefore = entry.findById(first.id);
  const viewStalled = entry.findById(first.id);
  assert.equal(viewBefore, viewStalled, "the synthesized view is reused while no new delta arrives");
  entry.appendPart(first.id, " delta");
  assert.notEqual(entry.findById(first.id), viewBefore, "a new delta replaces the view (diff sees the growth)");

  // Finalize materializes the stored item with the joined text.
  entry.finalizeParts(first.id);
  assert.equal(entry.hasParts(first.id), false, "parts record is dropped at finalize");
  assert.equal((entry[0] as { text: string }).text, "alpha beta gamma delta", "stored item carries the joined text");
  assert.equal(entry.toArray()[0]!.kind === "message" ? (entry.toArray()[0] as { text: string }).text : "", "alpha beta gamma delta");
});

test("unit: thinking block — parts finalize stamps endedAt with the joined text", () => {
  const entry = TranscriptCacheEntry.empty();
  const item = makeThinkingItem("step one ");
  entry.append(item);
  entry.beginParts(item.id, "step one ", item);
  entry.appendPart(item.id, "step two");
  assert.equal((entry[0] as { text: string }).text, "step one step two", "preview shows the live reasoning text");

  entry.finalizeParts(item.id, "2026-01-01T00:00:00.000Z");
  const finalized = entry[0]!;
  assert.equal(finalized.kind, "thinking");
  assert.equal((finalized as { text: string }).text, "step one step two", "joined text at finalize");
  assert.equal((finalized as { endedAt?: string }).endedAt, "2026-01-01T00:00:00.000Z", "endedAt stamped at finalize");
});

/* ── remove of the "Working…" row over the real fold ────── */

test("unit: run completion removes the transient Working… activity row", () => {
  const caches = freshCaches();
  const baseTs = Date.parse("2026-06-01T00:00:00.000Z");
  driveEvent(caches, sessionOpenedEvent(baseTs));
  driveEvent(caches, {
    type: "sessionUpdated",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs + 1).toISOString(),
    snapshot: {
      ref: TARGET_SESSION_REF,
      workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/store-ws" },
      title: "store session",
      status: "running",
      runningRunId: "run-1",
      updatedAt: new Date(baseTs + 1).toISOString(),
      queuedMessages: [],
    } as never,
  });
  assert.ok(
    caches.transcriptCache.get(KEY)?.toArray().some((item) => item.kind === "activity" && item.label === "Working…"),
    "the Working… row is present while the run streams",
  );
  driveEvent(caches, {
    type: "runCompleted",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs + 2).toISOString(),
    snapshot: {
      ref: TARGET_SESSION_REF,
      workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/store-ws" },
      title: "store session",
      status: "idle",
      updatedAt: new Date(baseTs + 2).toISOString(),
      queuedMessages: [],
    } as never,
  });
  const items = caches.transcriptCache.get(KEY)?.toArray() ?? [];
  assert.ok(
    !items.some((item) => item.kind === "activity" && item.label === "Working…"),
    "the Working… row is removed on run completion (the only permitted removal)",
  );
});

/* ── K′-style budget over the real fold path ────────────── */

interface FlowCaches {
  transcriptCache: Map<string, TranscriptCacheEntry>;
  runningSinceBySession: Map<string, string>;
  lastViewedAtBySession: Map<string, string>;
  activeAssistantMessageBySession: Map<string, string>;
  activeWorkingActivityBySession: Map<string, string>;
  activeThinkingBySession: Map<string, ActiveThinkingRecord>;
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

function sessionOpenedEvent(baseTs: number): SessionDriverEvent {
  return {
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
}

function driveEvent(caches: FlowCaches, event: SessionDriverEvent): void {
  if (event.type === "assistantDelta") {
    finalizeActiveThinking(caches.transcriptCache, caches.activeThinkingBySession, event.sessionRef);
    appendAssistantDelta(caches.transcriptCache, caches.activeAssistantMessageBySession, event.sessionRef, event.text);
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

function buildEvents(eventCount: number): SessionDriverEvent[] {
  const events: SessionDriverEvent[] = [];
  const baseTs = Date.parse("2026-06-01T00:00:00.000Z");
  let toolIndex = 0;
  events.push(sessionOpenedEvent(baseTs));
  for (let index = 1; index < eventCount; index += 1) {
    const timestamp = new Date(baseTs + index * 10).toISOString();
    if (index % 10 === 0) {
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
    if (index % 7 === 0) {
      events.push({ type: "assistantThinkingDelta", sessionRef: TARGET_SESSION_REF, timestamp, text: `reasoning step ${index} ` });
      continue;
    }
    events.push({ type: "assistantDelta", sessionRef: TARGET_SESSION_REF, timestamp, text: `delta ${index} ` });
  }
  events.push({
    type: "runCompleted",
    sessionRef: TARGET_SESSION_REF,
    timestamp: new Date(baseTs + eventCount * 10).toISOString(),
    snapshot: {
      ref: TARGET_SESSION_REF,
      workspace: { workspaceId: TARGET_WORKSPACE_ID, path: "/tmp/store-ws" },
      title: "store session",
      status: "idle",
      updatedAt: new Date(baseTs + eventCount * 10).toISOString(),
      queuedMessages: [],
    } as never,
  });
  return events;
}

test("K′-style budget: the real fold rebuilds at most one chunk per event (Σ set lengths ≤ 64 × events)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 300, max: 1500 }), (eventCount) => {
      const caches = freshCaches();
      let work = 0;
      // Behavioral detector: every `transcriptCache.set(key, entry)` copies
      // `entry.length` elements — the per-event element-copy budget.
      const proxiedCache = new Proxy(caches.transcriptCache, {
        get(target, prop, receiver) {
          if (prop === "get") {
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
      for (const event of buildEvents(eventCount)) {
        driveEvent({ ...caches, transcriptCache: proxiedCache }, event);
      }
      const bound = TRANSCRIPT_CHUNK_SIZE * eventCount;
      assert.ok(
        work <= bound,
        `fold path re-copied ${work} transcript elements over ${eventCount} events ` +
          `(linear bound ${bound}) — a per-event full-array rebuild would be quadratic on long tasks`,
      );
      assert.ok(
        work <= TRANSCRIPT_CHUNK_SIZE * 4,
        `the fold path should rebuild ~nothing per event (set only on entry creation), got ${work} elements`,
      );
    }),
    { numRuns: 20 },
  );
});

/* ── deterministic regression pin: long-task fold stays linear ── */

test("deterministic: 3000-event fold keeps set-rebuild work at ~0 and content coherent", () => {
  const caches = freshCaches();
  let work = 0;
  const proxiedCache = new Proxy(caches.transcriptCache, {
    get(target, prop, receiver) {
      if (prop === "get") {
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
  const events = buildEvents(3000);
  for (const event of events) {
    driveEvent({ ...caches, transcriptCache: proxiedCache }, event);
  }
  const bound = TRANSCRIPT_CHUNK_SIZE * events.length;
  assert.ok(work <= bound, `3000 events: set-rebuild work ${work} exceeds the linear bound ${bound}`);
  const items = caches.transcriptCache.get(KEY)?.toArray() ?? [];
  assert.ok(items.length > 0, "the transcript accumulated");
  // Content coherence: the accumulated assistant text equals the delivered deltas.
  let assistantChars = 0;
  for (const event of events) {
    if (event.type === "assistantDelta") {
      assistantChars += event.text.length;
    }
  }
  let seenAssistantChars = 0;
  for (const item of items) {
    if (item.kind === "message" && item.role === "assistant") {
      seenAssistantChars += item.text.length;
    }
  }
  assert.equal(seenAssistantChars, assistantChars, "no delta text lost or duplicated through the persistent structure");
});
