/**
 * Cardo PBT: timeline state-transformation invariants.
 *
 * Locks down:
 *  - timelineFromDriverTranscript: bijective mapping, pass-through of non-tool items,
 *    tool-item field preservation.
 *  - appendUserMessage / appendQueuedUserMessage / appendAssistantDelta: push /
 *    idempotent-replace / concatenation invariants, map mutation, no-throw on
 *    arbitrary input.
 *  - applyTimelineEvent: never throws on any SessionDriverEvent, assistantDelta
 *    no-op, queuedMessageStarted adds/updates, tool lifecycle converges on a single
 *    row, run-completion clears run state, other cache keys untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  appendAssistantDelta,
  appendQueuedUserMessage,
  appendThinkingDelta,
  appendUserMessage,
  applyTimelineEvent,
  finalizeActiveThinking,
  timelineFromDriverTranscript,
} from "../../out-pbt/desktop/electron/app-store-timeline.js";
import {
  arbDriverTranscriptItem,
  arbIsoTimestamp,
  arbOptionalString,
  arbQueuedMessage,
  arbSessionDriverEvent,
  arbSessionRef,
  arbSessionSnapshot,
  arbTranscript,
  arbTranscriptCache,
  arbUnknown,
  keyOf,
} from "./arbitraries.mts";
import type { SessionDriverEvent, SessionQueuedMessage, SessionRef } from "../../../../packages/session-driver/dist/index.js";
import type { TranscriptMessage } from "../../out-pbt/desktop/src/desktop-state.js";

const NUM_RUNS = 150;

type AnyMap = Map<string, unknown>;

/* ── helpers ────────────────────────────────────────────── */

/** Compare two transcripts modulo random ids and wall-clock createdAt (ids replaced by index). */
function transcriptsEqualModuloIds(left: readonly TranscriptMessage[], right: readonly TranscriptMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    const a = { ...(left[i] as unknown as Record<string, unknown>), id: i, createdAt: i };
    const b = { ...(right[i] as unknown as Record<string, unknown>), id: i, createdAt: i };
    assert.deepEqual(a, b);
  }
  return true;
}

function transcriptOf(cache: Map<string, TranscriptMessage[]>, refOrKey: SessionRef | string): TranscriptMessage[] {
  return cache.get(typeof refOrKey === "string" ? refOrKey : keyOf(refOrKey)) ?? [];
}

function runtimeState() {
  return {
    runMetricsBySession: new Map<string, { startedAt: string; toolCount: number; searchCount: number; fileCount: number }>(),
    runningSinceBySession: new Map<string, string>(),
    activeAssistantMessageBySession: new Map<string, string>(),
    activeWorkingActivityBySession: new Map<string, string>(),
    activeThinkingBySession: new Map<string, { id: string; text: string; startedAt: string }>(),
  };
}

/* ── timelineFromDriverTranscript ───────────────────────── */

test("timelineFromDriverTranscript: one output item per input item (map)", () => {
  fc.assert(
    fc.property(fc.array(arbDriverTranscriptItem(), { maxLength: 8 }), (items) => {
      const output = timelineFromDriverTranscript(items);
      assert.equal(output.length, items.length);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("timelineFromDriverTranscript: non-tool, non-thinking items pass through as-is (kind preserved)", () => {
  fc.assert(
    fc.property(fc.array(arbDriverTranscriptItem(), { maxLength: 8 }), (items) => {
      const output = timelineFromDriverTranscript(items);
      items.forEach((item, index) => {
        if (item.kind !== "tool" && item.kind !== "thinking") {
          assert.equal(output[index], item);
        }
      });
    }),
    { numRuns: NUM_RUNS },
  );
});

test("timelineFromDriverTranscript: tool items preserve callId/toolName/status/createdAt", () => {
  fc.assert(
    fc.property(fc.array(arbDriverTranscriptItem(), { maxLength: 8 }), (items) => {
      const output = timelineFromDriverTranscript(items);
      items.forEach((item, index) => {
        if (item.kind === "tool") {
          const out = output[index] as Extract<TranscriptMessage, { kind: "tool" }>;
          assert.equal(out.kind, "tool");
          assert.equal(out.callId, item.callId);
          assert.equal(out.toolName, item.toolName);
          assert.equal(out.status, item.status);
          assert.equal(out.createdAt, item.createdAt);
          if (item.input !== undefined) {
            assert.equal(out.input, item.input);
          }
          if (item.output !== undefined) {
            assert.equal(out.output, item.output);
          }
        }
      });
    }),
    { numRuns: NUM_RUNS },
  );
});

/* ── appendUserMessage ──────────────────────────────────── */

test("appendUserMessage: pushes exactly one user message with the given text and returns its id", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 80 }),
      fc.array(fc.record({ kind: fc.constant("file" as const), name: fc.string(), mimeType: fc.string(), fsPath: fc.string() }), { maxLength: 3 }),
      (cache, ref, text, attachments) => {
        const before = transcriptOf(cache, ref);
        const result = appendUserMessage(cache, ref, text, attachments as never);

        const after = transcriptOf(cache, ref);
        assert.equal(after.length, before.length + 1);
        const added = after[after.length - 1] as Extract<TranscriptMessage, { kind: "message" }>;
        assert.equal(added.kind, "message");
        assert.equal(added.role, "user");
        assert.equal(added.text, text);
        assert.equal(added.id, result);
        // Prior items keep their exact references.
        before.forEach((item, index) => assert.equal(after[index], item));
        if (attachments.length > 0) {
          assert.equal(added.attachments?.length, attachments.length);
        } else {
          assert.equal(added.attachments, undefined);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("appendUserMessage: never throws on arbitrary input; other cache keys untouched", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string(),
      (cache, ref, text) => {
        const key = keyOf(ref);
        const beforeOthers = [...cache.entries()].filter(([k]) => k !== key);
        appendUserMessage(cache, ref, text);
        const afterOthers = [...cache.entries()].filter(([k]) => k !== key);
        assert.equal(afterOthers.length, beforeOthers.length);
        beforeOthers.forEach(([k, v]) => assert.equal(cache.get(k), v));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

/* ── appendQueuedUserMessage ────────────────────────────── */

test("appendQueuedUserMessage: adds the message when absent; replaces in place when the id already exists", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      arbQueuedMessage(),
      (cache, ref, message) => {
        const key = keyOf(ref);
        const before = [...(cache.get(key) ?? [])];
        const existingIndex = before.findIndex((item) => item.kind === "message" && item.id === message.id);
        fc.pre(existingIndex === -1 || before.every((item) => item.kind !== "tool" || item.id !== message.id));

        appendQueuedUserMessage(cache, ref, message);

        const after = transcriptOf(cache, ref);
        const matches = after.filter((item) => item.id === message.id);
        assert.equal(matches.length, 1, "exactly one transcript item with the queued message id");
        const added = matches[0] as Extract<TranscriptMessage, { kind: "message" }>;
        assert.equal(added.kind, "message");
        assert.equal(added.role, "user");
        assert.equal(added.text, message.text);
        assert.equal(added.createdAt, message.createdAt);

        if (existingIndex === -1) {
          assert.equal(after.length, before.length + 1);
          assert.equal(after[after.length - 1], added);
          before.forEach((item, index) => assert.equal(after[index], item));
        } else {
          assert.equal(after.length, before.length);
          assert.equal(after[existingIndex], added);
          before.forEach((item, index) => {
            if (index !== existingIndex) {
              assert.equal(after[index], item);
            }
          });
        }

        if (message.attachments?.length) {
          assert.equal(added.attachments?.length, message.attachments.length);
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("appendQueuedUserMessage: re-adding the same id replaces (idempotent, no duplicates)", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      arbQueuedMessage(),
      fc.string({ minLength: 0, maxLength: 60 }),
      (cache, ref, message, replacementText) => {
        appendQueuedUserMessage(cache, ref, message);
        appendQueuedUserMessage(cache, ref, { ...message, text: replacementText });

        const after = transcriptOf(cache, ref);
        assert.equal(after.filter((item) => item.id === message.id).length, 1);
        const added = after.find((item) => item.id === message.id) as Extract<TranscriptMessage, { kind: "message" }>;
        assert.equal(added.text, replacementText);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

/* ── appendAssistantDelta ───────────────────────────────── */

test("appendAssistantDelta: two sequential deltas equal one combined delta (modulo ids)", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 40 }),
      fc.string({ minLength: 0, maxLength: 40 }),
      (cache, ref, first, second) => {
        const refA = { workspaceId: ref.workspaceId, sessionId: ref.sessionId };
        const cacheA = new Map([...cache].map(([k, v]) => [k, [...v]]));
        const activeA = new Map<string, string>();
        appendAssistantDelta(cacheA, activeA, refA, first);
        appendAssistantDelta(cacheA, activeA, refA, second);

        const cacheB = new Map([...cache].map(([k, v]) => [k, [...v]]));
        const activeB = new Map<string, string>();
        appendAssistantDelta(cacheB, activeB, refA, `${first}${second}`);

        assert.ok(
          transcriptsEqualModuloIds(transcriptOf(cacheA, refA), transcriptOf(cacheB, refA)),
          "sequential deltas must produce the same transcript as one combined delta",
        );
        // The active assistant message id points at a real message in both cases.
        const activeIdA = activeA.get(keyOf(refA));
        const activeIdB = activeB.get(keyOf(refA));
        assert.ok(activeIdA && transcriptOf(cacheA, refA).some((m) => m.id === activeIdA));
        assert.ok(activeIdB && transcriptOf(cacheB, refA).some((m) => m.id === activeIdB));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("appendAssistantDelta: creates a new assistant message when none is active; appends when active resolves", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 60 }),
      (cache, ref, text) => {
        const key = keyOf(ref);
        const active = new Map<string, string>();
        const before = transcriptOf(cache, ref);

        appendAssistantDelta(cache, active, ref, text);

        const after = transcriptOf(cache, ref);
        assert.equal(after.length, before.length + 1, "exactly one new transcript item");
        const activeId = active.get(key);
        assert.ok(activeId, "active assistant message id must be recorded");
        const activeMessage = after.find((m) => m.id === activeId) as Extract<TranscriptMessage, { kind: "message" }>;
        assert.ok(activeMessage, "active assistant message must exist in the transcript");
        assert.equal(activeMessage.kind, "message");
        assert.equal(activeMessage.role, "assistant");
        assert.equal(activeMessage.text, text);

        // Second delta appends to the same message.
        appendAssistantDelta(cache, active, ref, "-tail");
        const after2 = transcriptOf(cache, ref);
        assert.equal(after2.length, after.length, "no new item when an active assistant message exists");
        assert.equal((after2.find((m) => m.id === activeId) as Extract<TranscriptMessage, { kind: "message" }>).text, `${text}-tail`);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

/* ── appendThinkingDelta / finalizeActiveThinking ───────── */

function thinkingItemsOf(transcript: readonly TranscriptMessage[]) {
  return transcript.filter((item) => item.kind === "thinking") as Extract<TranscriptMessage, { kind: "thinking" }>[];
}

test("appendThinkingDelta: sequential deltas accumulate into one thinking item with startedAt", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 40 }),
      fc.string({ minLength: 0, maxLength: 40 }),
      (cache, ref, first, second) => {
        const key = keyOf(ref);
        const active = new Map<string, { id: string; text: string; startedAt: string }>();
        const before = transcriptOf(cache, ref);
        const beforeThinking = thinkingItemsOf(before).length;

        appendThinkingDelta(cache, active, ref, first);
        const afterFirst = transcriptOf(cache, ref);
        assert.equal(afterFirst.length, before.length + 1, "first delta appends exactly one item");
        assert.equal(thinkingItemsOf(afterFirst).length, beforeThinking + 1);
        const record = active.get(key);
        assert.ok(record, "active thinking record must be recorded");
        assert.ok(record.startedAt, "startedAt must be set");
        const firstItem = afterFirst.find((item) => item.id === record.id);
        assert.ok(firstItem && firstItem.kind === "thinking");
        assert.equal(firstItem.text, first);

        appendThinkingDelta(cache, active, ref, second);
        const after = transcriptOf(cache, ref);
        assert.equal(after.length, afterFirst.length, "second delta appends to the same item");
        assert.equal(thinkingItemsOf(after).length, beforeThinking + 1);
        const item = after.find((item) => item.id === record.id);
        assert.ok(item && item.kind === "thinking");
        assert.equal(item.text, `${first}${second}`);
        assert.equal(active.get(key)?.id, record.id, "active record id stays stable");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("appendThinkingDelta: never throws on arbitrary input; only the event's session key is touched", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string(),
      (cache, ref, text) => {
        const key = keyOf(ref);
        const active = new Map<string, { id: string; text: string; startedAt: string }>();
        const beforeOthers = [...cache.entries()].filter(([k]) => k !== key);
        appendThinkingDelta(cache, active, ref, text);
        const afterOthers = [...cache.entries()].filter(([k]) => k !== key);
        assert.equal(afterOthers.length, beforeOthers.length);
        beforeOthers.forEach(([k, v]) => assert.equal(cache.get(k), v));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("finalizeActiveThinking: stamps endedAt on the active item and clears the record", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 60 }),
      arbIsoTimestamp(),
      (cache, ref, text, endedAt) => {
        const key = keyOf(ref);
        const active = new Map<string, { id: string; text: string; startedAt: string }>();
        appendThinkingDelta(cache, active, ref, text);
        const record = active.get(key);
        assert.ok(record);

        finalizeActiveThinking(cache, active, ref, endedAt);

        assert.equal(active.get(key), undefined, "active record cleared");
        const item = transcriptOf(cache, ref).find((i) => i.id === record.id);
        assert.ok(item && item.kind === "thinking");
        assert.equal(item.endedAt, endedAt);
        assert.equal(item.text, text, "finalize must not mutate the thinking text");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("finalizeActiveThinking: no-op (cache reference-identical) when nothing is streaming", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      (cache, ref) => {
        const key = keyOf(ref);
        const active = new Map<string, { id: string; text: string; startedAt: string }>();
        const before = [...cache.entries()];
        const beforeTranscript = cache.get(key);

        finalizeActiveThinking(cache, active, ref);

        assert.equal(cache.size, before.length);
        for (const [k, v] of before) {
          assert.equal(cache.get(k), v);
        }
        assert.equal(cache.get(key), beforeTranscript, "cache entry must be reference-identical when nothing active");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: assistantThinkingDelta is a complete no-op (append happens via appendThinkingDelta)", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string(),
      arbRuntimeMaps(),
      (cache, ref, text, runtime) => {
        const key = keyOf(ref);
        const before = [...cache.entries()];
        const event = { type: "assistantThinkingDelta", sessionRef: ref, timestamp: new Date().toISOString(), text } as SessionDriverEvent;

        applyTimelineEvent(cache, event, runtime as never);

        assert.equal(cache.size, before.length);
        for (const [k, v] of before) {
          assert.equal(cache.get(k), v, `cache entry ${k} must be reference-identical`);
        }
        assert.equal(cache.get(key), before.find(([k]) => k === key)?.[1]);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: toolStarted finalizes the active thinking block (collapses it)", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 60 }),
      fc.string({ minLength: 1, maxLength: 20 }),
      (cache, ref, thinkingText, toolName) => {
        const key = keyOf(ref);
        const runtime = runtimeState();
        appendThinkingDelta(cache, runtime.activeThinkingBySession, ref, thinkingText);
        const record = (runtime.activeThinkingBySession as Map<string, { id: string; text: string; startedAt: string }>).get(key);
        assert.ok(record, "thinking must be streaming before the tool starts");

        applyTimelineEvent(
          cache,
          { type: "toolStarted", sessionRef: ref, timestamp: new Date().toISOString(), toolName, callId: "call-1" } as SessionDriverEvent,
          runtime as never,
        );

        assert.equal((runtime.activeThinkingBySession as Map<string, string>).get(key), undefined, "thinking finalized");
        const thinking = transcriptOf(cache, ref).find((item) => item.id === record.id);
        assert.ok(thinking && thinking.kind === "thinking");
        assert.ok(thinking.endedAt, "endedAt must be stamped");
        assert.equal(thinking.text, thinkingText);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: runCompleted finalizes the active thinking block", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 60 }),
      arbSessionSnapshot(),
      (cache, ref, thinkingText, snapshot) => {
        const key = keyOf(ref);
        const runtime = runtimeState();
        appendThinkingDelta(cache, runtime.activeThinkingBySession, ref, thinkingText);
        const record = (runtime.activeThinkingBySession as Map<string, { id: string; text: string; startedAt: string }>).get(key);
        assert.ok(record);

        applyTimelineEvent(
          cache,
          { type: "runCompleted", sessionRef: ref, timestamp: new Date().toISOString(), snapshot } as SessionDriverEvent,
          runtime as never,
        );

        assert.equal((runtime.activeThinkingBySession as Map<string, string>).get(key), undefined);
        const thinking = transcriptOf(cache, ref).find((item) => item.id === record.id);
        assert.ok(thinking && thinking.kind === "thinking");
        assert.ok(thinking.endedAt, "endedAt must be stamped");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("timelineFromDriverTranscript: thinking items map with endedAt set to createdAt (persisted blocks render collapsed)", () => {
  fc.assert(
    fc.property(fc.array(arbDriverTranscriptItem(), { maxLength: 8 }), (items) => {
      const output = timelineFromDriverTranscript(items);
      assert.equal(output.length, items.length);
      items.forEach((item, index) => {
        if (item.kind !== "thinking") {
          return;
        }
        const out = output[index] as Extract<TranscriptMessage, { kind: "thinking" }>;
        assert.equal(out.kind, "thinking");
        assert.equal(out.id, item.id);
        assert.equal(out.text, item.text);
        assert.equal(out.createdAt, item.createdAt);
        assert.equal(out.endedAt, item.createdAt, "persisted thinking must be finalized");
        assert.equal(out.startedAt, undefined);
      });
    }),
    { numRuns: NUM_RUNS },
  );
});

/* ── applyTimelineEvent ─────────────────────────────────── */

function arbRuntimeMaps(): fc.Arbitrary<{
  runMetricsBySession: AnyMap;
  runningSinceBySession: AnyMap;
  activeAssistantMessageBySession: AnyMap;
  activeWorkingActivityBySession: AnyMap;
  activeThinkingBySession: AnyMap;
}> {
  return fc.record({
    runMetricsBySession: fc.array(fc.tuple(fc.string(), fc.record({ startedAt: arbIsoTimestamp(), toolCount: fc.integer(), searchCount: fc.integer(), fileCount: fc.integer() }))).map((p) => new Map(p)),
    runningSinceBySession: fc.array(fc.tuple(fc.string(), arbIsoTimestamp())).map((p) => new Map(p)),
    activeAssistantMessageBySession: fc.array(fc.tuple(fc.string(), fc.uuid())).map((p) => new Map(p)),
    activeWorkingActivityBySession: fc.array(fc.tuple(fc.string(), fc.uuid())).map((p) => new Map(p)),
    activeThinkingBySession: fc.array(fc.tuple(fc.string(), fc.record({ id: fc.uuid(), text: fc.string({ minLength: 0, maxLength: 60 }), startedAt: arbIsoTimestamp() }))).map((p) => new Map(p)),
  });
}

test("applyTimelineEvent: never throws on any SessionDriverEvent shape", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      arbSessionDriverEvent(arbSessionRef()),
      arbRuntimeMaps(),
      (cache, _ref, event, runtime) => {
        const transcriptCache = new Map([...cache].map(([k, v]) => [k, [...v]]));
        applyTimelineEvent(transcriptCache, event, runtime as never);
        return true;
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: assistantDelta is a complete no-op", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string(),
      arbRuntimeMaps(),
      (cache, ref, text, runtime) => {
        const key = keyOf(ref);
        const before = [...cache.entries()];
        const event = { type: "assistantDelta", sessionRef: ref, timestamp: new Date().toISOString(), text } as SessionDriverEvent;

        applyTimelineEvent(cache, event, runtime as never);

        assert.equal(cache.size, before.length);
        for (const [k, v] of before) {
          assert.equal(cache.get(k), v, `cache entry ${k} must be reference-identical`);
        }
        assert.equal(cache.get(key), before.find(([k]) => k === key)?.[1]);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: only the event's session key is touched in cache and runtime maps", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      arbSessionDriverEvent(arbSessionRef()),
      arbRuntimeMaps(),
      (cache, _ref, event, runtime) => {
        const key = keyOf(event.sessionRef);
        const beforeCache = new Map([...cache].map(([k, v]) => [k, v]));
        const beforeRuntime = new Map(
          (Object.keys(runtime) as (keyof typeof runtime)[]).map((name) => [
            name,
            new Map(runtime[name] as AnyMap),
          ]),
        );

        applyTimelineEvent(cache, event, runtime as never);

        for (const [k, v] of beforeCache) {
          if (k !== key) {
            assert.equal(cache.get(k), v, `cache key ${k} must be untouched`);
          }
        }
        for (const name of Object.keys(beforeRuntime) as (keyof typeof runtime)[]) {
          const beforeMap = beforeRuntime.get(name) as AnyMap;
          const afterMap = runtime[name] as AnyMap;
          for (const [k, v] of beforeMap) {
            if (k !== key) {
              assert.equal(afterMap.get(k), v, `runtime map ${String(name)} key ${k} must be untouched`);
            }
          }
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: queuedMessageStarted adds or replaces the queued message in the transcript", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      arbQueuedMessage(),
      arbRuntimeMaps(),
      (cache, ref, message, runtime) => {
        const key = keyOf(ref);
        const before = [...(cache.get(key) ?? [])];
        const existingMessageIndex = before.findIndex((item) => item.kind === "message" && item.id === message.id);
        fc.pre(existingMessageIndex === -1 || before.every((item) => item.kind !== "tool" || item.id !== message.id));

        const event = {
          type: "queuedMessageStarted",
          sessionRef: ref,
          timestamp: new Date().toISOString(),
          message,
        } as SessionDriverEvent;
        applyTimelineEvent(cache, event, runtime as never);

        const after = transcriptOf(cache, ref);
        assert.equal(after.filter((item) => item.id === message.id).length, 1);
        const added = after.find((item) => item.id === message.id) as Extract<TranscriptMessage, { kind: "message" }>;
        assert.equal(added.kind, "message");
        assert.equal(added.role, "user");
        assert.equal(added.text, message.text);
        assert.equal(added.createdAt, message.createdAt);
        assert.equal(after.length, existingMessageIndex === -1 ? before.length + 1 : before.length);
        // The active assistant message is cleared when a queued message starts.
        assert.equal((runtime.activeAssistantMessageBySession as Map<string, string>).get(key), undefined);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: tool lifecycle for one callId converges on a single tool row with the final status", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.uuid(),
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.boolean(),
      fc.boolean(),
      arbUnknown(),
      (cache, ref, callId, toolName, updated, success, output) => {
        const key = keyOf(ref);
        const base = { sessionRef: ref, timestamp: new Date().toISOString(), callId } as const;
        const runtime = runtimeState();

        const before = transcriptOf(cache, ref);
        const beforeToolRows = before.filter((item) => item.kind === "tool").length;
        // The lifecycle invariants below assume a fresh callId; the pre-existing-row
        // upsert case is covered by the dedicated test after this one.
        fc.pre(!before.some((item) => item.kind === "tool" && (item as { callId: string }).callId === callId));

        applyTimelineEvent(cache, { ...base, type: "toolStarted", toolName } as SessionDriverEvent, runtime as never);
        const afterStart = transcriptOf(cache, ref);
        const startRows = afterStart.filter((item) => item.kind === "tool" && (item as { callId: string }).callId === callId);
        assert.equal(startRows.length, 1, "toolStarted must create exactly one tool row");
        const startRow = startRows[0] as Extract<TranscriptMessage, { kind: "tool" }>;
        assert.equal(startRow.toolName, toolName);
        assert.equal(startRow.status, "running");
        assert.equal(afterStart.length, before.length + 1, "toolStarted appends exactly one item");

        if (updated) {
          applyTimelineEvent(cache, { ...base, type: "toolUpdated", text: "progress note" } as SessionDriverEvent, runtime as never);
          const midRows = transcriptOf(cache, ref).filter((item) => item.kind === "tool" && (item as { callId: string }).callId === callId);
          assert.equal(midRows.length, 1, "toolUpdated must not create a duplicate tool row");
          assert.equal(afterStart.length, transcriptOf(cache, ref).length, "toolUpdated must not change transcript length");
        }

        applyTimelineEvent(
          cache,
          { ...base, type: "toolFinished", success, output } as SessionDriverEvent,
          runtime as never,
        );
        const after = transcriptOf(cache, ref);
        const rows = after.filter((item) => item.kind === "tool" && (item as { callId: string }).callId === callId);
        assert.equal(rows.length, 1, "toolFinished must leave exactly one tool row for the callId");
        const row = rows[0] as Extract<TranscriptMessage, { kind: "tool" }>;
        assert.equal(row.status, success ? "success" : "error");
        // Output is preserved when the event carries a non-nullish output; null/undefined
        // fall through to the row's previous output (upsert keeps prior fields).
        if (output !== undefined && output !== null) {
          assert.deepEqual(row.output, output);
        }
        assert.equal(after.length, before.length + 1, "no extra rows after the tool lifecycle");
        assert.equal(after.filter((item) => item.kind === "tool").length, beforeToolRows + 1);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: toolStarted on a pre-existing row with the same callId upserts in place (no duplicate)", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.uuid(),
      fc.string({ minLength: 1, maxLength: 20 }),
      (cache, ref, callId, toolName) => {
        const key = keyOf(ref);
        const runtime = runtimeState();
        const existing = transcriptOf(cache, ref);
        fc.pre(!existing.some((item) => item.kind === "tool" && (item as { callId: string }).callId === callId));
        // Seed a transcript that already contains a tool row for this callId.
        const transcript = [
          ...existing,
          {
            kind: "tool" as const,
            id: callId,
            callId,
            toolName: "pre-existing",
            status: "running" as const,
            label: "pre-existing row",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ];
        const seeded = new Map([...cache, [key, transcript]]);

        const beforeCount = transcript.filter((item) => item.kind === "tool" && (item as { callId: string }).callId === callId).length;
        assert.equal(beforeCount, 1);
        const totalBefore = transcript.length;

        applyTimelineEvent(
          seeded,
          { type: "toolStarted", sessionRef: ref, timestamp: new Date().toISOString(), toolName, callId } as SessionDriverEvent,
          runtime as never,
        );
        const after = seeded.get(key) ?? [];
        const rows = after.filter((item) => item.kind === "tool" && (item as { callId: string }).callId === callId);
        assert.equal(rows.length, 1, "toolStarted must converge on one row even when one already exists");
        assert.equal(after.length, totalBefore, "no new item appended for an existing callId");
        assert.equal((rows[0] as Extract<TranscriptMessage, { kind: "tool" }>).toolName, toolName, "existing row updated in place");
        assert.equal((rows[0] as Extract<TranscriptMessage, { kind: "tool" }>).status, "running");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: runCompleted/runFailed/sessionClosed clear runningSince and run metrics", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionDriverEvent(arbSessionRef()),
      (cache, event) => {
        fc.pre(["runCompleted", "runFailed", "sessionClosed"].includes(event.type));
        const key = keyOf(event.sessionRef);
        const runtime = runtimeState();
        runtime.runningSinceBySession.set(key, "2024-01-01T00:00:00.000Z");
        runtime.runMetricsBySession.set(key, { startedAt: "2024-01-01T00:00:00.000Z", toolCount: 3, searchCount: 1, fileCount: 0 });

        applyTimelineEvent(cache, event, runtime as never);

        assert.equal(runtime.runningSinceBySession.get(key), undefined, "runningSince must be cleared");
        assert.equal(runtime.runMetricsBySession.get(key), undefined, "run metrics must be cleared");
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: sessionOpened/sessionClosed append a closing activity item; runCompleted ends with a divider summary", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionDriverEvent(arbSessionRef()),
      (cache, event) => {
        fc.pre(["sessionOpened", "sessionClosed", "runCompleted"].includes(event.type));
        const key = keyOf(event.sessionRef);
        const runtime = runtimeState();
        const before = [...(cache.get(key) ?? [])];

        applyTimelineEvent(cache, event, runtime as never);

        const after = transcriptOf(cache, key);
        const delta = after.length - before.length;
        const last = after[after.length - 1];
        if (event.type === "sessionOpened") {
          assert.equal(delta, 1);
          assert.equal((last as { kind: string }).kind, "activity");
          assert.equal((last as { label: string }).label, "Resumed session");
        } else if (event.type === "sessionClosed") {
          assert.equal(delta, 1);
          assert.equal((last as { kind: string }).kind, "activity");
          assert.equal((last as { label: string }).label, "Stopped");
        } else {
          assert.ok(delta === 1 || delta === 2, `runCompleted appends 1-2 items, got ${delta}`);
          assert.equal((last as { kind: string }).kind, "summary");
          assert.equal((last as { presentation: string }).presentation, "divider");
        }
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("applyTimelineEvent: hostUiRequest notify appends an activity with the request message", () => {
  fc.assert(
    fc.property(
      arbTranscriptCache(),
      arbSessionRef(),
      fc.string({ minLength: 0, maxLength: 60 }),
      (cache, ref, message) => {
        const key = keyOf(ref);
        const runtime = runtimeState();
        const before = [...(cache.get(key) ?? [])];
        const event = {
          type: "hostUiRequest",
          sessionRef: ref,
          timestamp: new Date().toISOString(),
          request: { kind: "notify", requestId: "req-1", message },
        } as SessionDriverEvent;

        applyTimelineEvent(cache, event, runtime as never);

        const after = transcriptOf(cache, ref);
        assert.equal(after.length, before.length + 1);
        const last = after[after.length - 1] as { kind: string; label: string };
        assert.equal(last.kind, "activity");
        assert.equal(last.label, message);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});
