/**
 * Cardo PBT: buildDisplayTimelineItems invariants.
 *
 * Locks down:
 *  - tool-group derivation: consecutive tool items collapse into one tool-group
 *    row (only when a request has >= 2 calls); lone tools stay plain items.
 *  - group identity is stable under append-only growth (a second batch after a
 *    separator starts a new group, the first group keeps its id).
 *  - non-tool items pass through in order; turn markers only appear after user
 *    messages with >= 1s of downstream work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { buildDisplayTimelineItems } from "../../out-pbt/desktop/src/timeline-turns.js";
import type { DisplayTimelineItem, TimelineToolGroup, TranscriptMessage } from "../../out-pbt/desktop/src/timeline-types.js";

const NUM_RUNS = 150;
const ISO = (sec: number): string => new Date(2026, 0, 1, 0, 0, sec).toISOString();

function toolItem(callId: string, seconds: number): Extract<TranscriptMessage, { kind: "tool" }> {
  return {
    kind: "tool",
    id: callId,
    callId,
    toolName: "bash",
    status: "success",
    label: `Ran bash: ${callId}`,
    createdAt: ISO(seconds),
  };
}

function userMessage(text = "prompt", seconds = 0): Extract<TranscriptMessage, { kind: "message" }> {
  return { kind: "message", id: `user-${text}-${seconds}`, role: "user", text, createdAt: ISO(seconds) };
}

function assistantMessage(text: string, seconds: number): Extract<TranscriptMessage, { kind: "message" }> {
  return { kind: "message", id: `assistant-${seconds}`, role: "assistant", text, createdAt: ISO(seconds) };
}

function groupOf(items: readonly DisplayTimelineItem[], index: number): TimelineToolGroup | undefined {
  const item = items[index];
  return item?.kind === "tool-group" ? item : undefined;
}

/* ── grouping ───────────────────────────────────────────── */

test("buildDisplayTimelineItems: two or more consecutive tool items collapse into one tool-group", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
      const tools = Array.from({ length: n }, (_, i) => toolItem(`call-${i}`, i + 1));
      const items = buildDisplayTimelineItems(tools);
      assert.equal(items.length, 1, "a batch of n >= 2 tools yields exactly one row");
      const group = groupOf(items, 0);
      assert.ok(group, "the row must be a tool-group");
      assert.equal(group.items.length, n);
      assert.equal(group.items[0]!.callId, "call-0");
      assert.equal(group.items[n - 1]!.callId, `call-${n - 1}`);
      assert.equal(group.createdAt, tools[n - 1]!.createdAt);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildDisplayTimelineItems: a lone tool call stays a plain tool item (no group)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 3 }), (separators) => {
      const transcript: TranscriptMessage[] = [];
      for (let i = 0; i < separators; i += 1) {
        transcript.push(userMessage(`p${i}`, i * 10));
      }
      const single = toolItem("call-solo", separators * 10 + 1);
      const items = buildDisplayTimelineItems([...transcript, single]);
      const tools = items.filter((item) => item.kind === "tool");
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.kind, "tool");
      assert.equal((tools[0] as Extract<TranscriptMessage, { kind: "tool" }>).callId, "call-solo");
      assert.equal(items.some((item) => item.kind === "tool-group"), false);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildDisplayTimelineItems: a separator splits batches; group identity is stable under append-only growth", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 5 }), (n) => {
      const first = Array.from({ length: n }, (_, i) => toolItem(`batch1-${i}`, i + 1));
      const initial = buildDisplayTimelineItems(first);
      const initialGroup = groupOf(initial, 0);
      assert.ok(initialGroup, "first batch must group");
      const firstId = initialGroup.id;

      // A second batch after a separator must start a NEW group; the first keeps its id.
      const second = [assistantMessage("text between", 20), ...Array.from({ length: 2 }, (_, i) => toolItem(`batch2-${i}`, 21 + i))];
      const grown = buildDisplayTimelineItems([...first, ...second]);
      const groups = grown.filter((item) => item.kind === "tool-group");
      assert.equal(groups.length, 2, "two batches => two groups");
      assert.equal(groups[0]!.id, firstId, "first group id must stay stable as the transcript grows");
      assert.equal(groups[1]!.items.length, 2);
      assert.equal(groups[1]!.items[0]!.callId, "batch2-0");
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildDisplayTimelineItems: non-tool items keep their order and pass through unchanged", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(userMessage("a"), userMessage("b"), assistantMessage("m", 5)), { maxLength: 8 }),
      fc.integer({ min: 0, max: 3 }),
      (messages, toolCount) => {
        const transcript = [...messages, ...Array.from({ length: toolCount }, (_, i) => toolItem(`t${i}`, 50 + i))];
        const items = buildDisplayTimelineItems(transcript);
        const passthrough = items.filter((item) => item.kind !== "tool" && item.kind !== "tool-group" && item.kind !== "turn-marker");
        assert.equal(passthrough.length, messages.length);
        messages.forEach((message, index) => assert.equal(passthrough[index], message));
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

/* ── turn markers ───────────────────────────────────────── */

test("buildDisplayTimelineItems: turn markers only appear after user messages with >= 1s of work", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 3 }), fc.boolean(), (n, spaced) => {
      const tools = Array.from({ length: n }, (_, i) => toolItem(`c${i}`, spaced ? 2 + i * 2 : 1));
      const transcript = [userMessage("prompt", 0), ...tools];
      const items = buildDisplayTimelineItems(transcript);
      const markers = items.filter((item) => item.kind === "turn-marker");
      const hasWork = n > 0;
      const durationMs = hasWork ? Date.parse(tools[n - 1]!.createdAt) - Date.parse(transcript[0]!.createdAt) : 0;
      assert.equal(markers.length, hasWork && durationMs >= 1000 ? 1 : 0);
      if (markers.length === 1) {
        const markerIndex = items.findIndex((item) => item.kind === "turn-marker");
        assert.ok(markerIndex > 0, "marker sits after the prompt");
        assert.equal(items[markerIndex - 1], transcript[0], "marker immediately follows its user message");
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildDisplayTimelineItems: never throws on arbitrary transcript arrays", () => {
  fc.assert(
    fc.property(fc.array(fc.anything(), { maxLength: 12 }), (transcript) => {
      const items = buildDisplayTimelineItems(transcript as TranscriptMessage[]);
      assert.ok(Array.isArray(items));
      return true;
    }),
    { numRuns: NUM_RUNS },
  );
});
