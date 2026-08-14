import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { messageText, transcriptFromMessages } from "../dist/session-supervisor-utils.js";
import type { SessionTranscriptItem } from "../dist/transcript.js";

const FALLBACK = "2026-01-01T00:00:00.000Z";

/** Assistant messages with plain string content (no attachment preamble). */
const plainAssistantArb = fc.record({
  role: fc.constant("assistant"),
  id: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  content: fc.string({ maxLength: 60 }),
  createdAt: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
  timestamp: fc.option(fc.integer({ min: -8.64e15, max: 8.64e15 }), { nil: undefined }),
});

const toolCallPartArb = fc.record({
  type: fc.constant("toolCall"),
  id: fc.string({ minLength: 1, maxLength: 20 }),
  name: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  arguments: fc.option(fc.anything(), { nil: undefined }),
});

const toolResultArb = fc.record({
  role: fc.constant("toolResult"),
  toolCallId: fc.string({ minLength: 1, maxLength: 20 }),
  toolName: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  isError: fc.option(fc.boolean(), { nil: undefined }),
  content: fc.option(fc.anything(), { nil: undefined }),
  details: fc.option(fc.anything(), { nil: undefined }),
  createdAt: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
});

function messageItems(transcript: readonly SessionTranscriptItem[]) {
  return transcript.filter((item) => item.kind === "message");
}
function toolItems(transcript: readonly SessionTranscriptItem[]) {
  return transcript.filter((item) => item.kind === "tool");
}

test("PBT transcriptFromMessages: never throws on arbitrary message arrays", () => {
  fc.assert(
    fc.property(fc.array(fc.anything(), { maxLength: 20 }), (messages) => {
      const out = transcriptFromMessages(messages, FALLBACK);
      assert.ok(Array.isArray(out));
      return true;
    }),
  );
});

test("PBT transcriptFromMessages: empty input yields empty transcript", () => {
  assert.deepEqual(transcriptFromMessages([], FALLBACK), []);
});

test("PBT transcriptFromMessages: assistant text messages are preserved in order with role and text", () => {
  fc.assert(
    fc.property(fc.array(plainAssistantArb, { maxLength: 10 }), (messages) => {
      const out = transcriptFromMessages(messages, FALLBACK);
      const items = messageItems(out);
      const qualifying = messages.filter((m) => m.content.trim().length > 0);
      assert.equal(items.length, qualifying.length, "one message item per text-bearing assistant message");
      qualifying.forEach((m, i) => {
        assert.equal(items[i]!.kind, "message");
        assert.equal(items[i]!.role, "assistant");
        assert.equal(items[i]!.text, m.content.trim());
      });
      return true;
    }),
  );
});

test("PBT transcriptFromMessages: message-kind item count never exceeds input count", () => {
  fc.assert(
    fc.property(fc.array(fc.anything(), { maxLength: 15 }), (messages) => {
      const out = transcriptFromMessages(messages, FALLBACK);
      assert.ok(messageItems(out).length <= messages.length, "at most one message item per input record");
      return true;
    }),
  );
});

test("PBT transcriptFromMessages: every item carries a string createdAt derived from the message or fallback", () => {
  fc.assert(
    fc.property(
      plainAssistantArb.filter((m) => m.content.trim().length > 0),
      fc.string({ maxLength: 30 }),
      (message, fallback) => {
        const out = transcriptFromMessages([message], fallback);
        assert.ok(out.length > 0, "assistant with non-empty content must yield at least one item");
        for (const item of out) {
          assert.equal(typeof item.createdAt, "string");
          if (typeof message.createdAt === "string") {
            assert.equal(item.createdAt, message.createdAt, "string createdAt wins");
          } else if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
            const date = new Date(message.timestamp);
            if (!Number.isNaN(date.getTime())) {
              assert.equal(item.createdAt, date.toISOString(), "valid numeric timestamp is ISO-formatted");
            } else {
              assert.equal(item.createdAt, fallback, "out-of-range timestamp falls back");
            }
          } else {
            assert.equal(item.createdAt, fallback);
          }
        }
        return true;
      },
    ),
  );
});

test("PBT transcriptFromMessages: assistant tool-call parts each yield one tool item with matching identity", () => {
  fc.assert(
    fc.property(fc.array(toolCallPartArb, { maxLength: 4 }), (parts) => {
      const message = { role: "assistant", content: [...parts], createdAt: FALLBACK };
      const out = transcriptFromMessages([message], FALLBACK);
      const tools = toolItems(out);
      assert.equal(tools.length, parts.length, "one tool item per tool-call part");
      for (const part of parts) {
        const tool = tools.find((t) => t.callId === part.id);
        assert.ok(tool, `tool item for call ${part.id} must exist`);
        assert.equal(tool!.kind, "tool");
        assert.equal(tool!.id, part.id);
        assert.equal(tool!.toolName, typeof part.name === "string" ? part.name : "tool");
        assert.equal(tool!.status, "error", "unresolved calls are marked error");
        assert.equal(tool!.createdAt, FALLBACK);
      }
      return true;
    }),
  );
});

test("PBT transcriptFromMessages: orphan tool results append exactly one tool item with correct status", () => {
  fc.assert(
    fc.property(toolResultArb, (message) => {
      const out = transcriptFromMessages([message], FALLBACK);
      const tools = toolItems(out);
      assert.equal(tools.length, 1);
      const tool = tools[0]!;
      assert.equal(tool.callId, message.toolCallId);
      assert.equal(tool.id, message.toolCallId);
      assert.equal(tool.status, message.isError === true ? "error" : "success");
      assert.equal(tool.toolName, typeof message.toolName === "string" ? message.toolName : "tool");
      assert.equal(tool.createdAt, typeof message.createdAt === "string" ? message.createdAt : FALLBACK);
      return true;
    }),
  );
});

test("PBT transcriptFromMessages: matching tool results update the call in place (no duplicates)", () => {
  fc.assert(
    fc.property(fc.array(toolCallPartArb, { maxLength: 3 }), fc.boolean(), (parts, isError) => {
      const messages = [
        { role: "assistant", content: [...parts] },
        ...parts.map((p) => ({ role: "toolResult", toolCallId: p.id, isError })),
      ];
      const out = transcriptFromMessages(messages, FALLBACK);
      const tools = toolItems(out);
      assert.equal(tools.length, parts.length, "each call updated in place, no duplicate tool items");
      for (const part of parts) {
        const tool = tools.find((t) => t.callId === part.id);
        assert.ok(tool);
        assert.equal(tool!.status, isError ? "error" : "success");
        assert.equal(tool!.toolName, typeof part.name === "string" ? part.name : "tool");
      }
      return true;
    }),
  );
});

test("PBT transcriptFromMessages: summary roles map to message items with the summary text", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("branchSummary", "compactionSummary"),
      fc.string({ maxLength: 60 }),
      (role, summary) => {
        const out = transcriptFromMessages([{ role, summary }], FALLBACK);
        if (summary.trim().length === 0) {
          assert.equal(out.length, 0, "empty summary yields no item");
        } else {
          assert.equal(out.length, 1);
          assert.equal(out[0]!.kind, "message");
          assert.equal(out[0]!.role, role);
          assert.equal(out[0]!.text, summary.trim());
        }
        return true;
      },
    ),
  );
});

test("PBT transcriptFromMessages: messageText consistency — item text equals messageText(message)", () => {
  fc.assert(
    fc.property(plainAssistantArb, (message) => {
      const out = transcriptFromMessages([message], FALLBACK);
      const text = messageText(message);
      if (text) {
        assert.equal(out[0]!.kind, "message");
        assert.equal(out[0]!.text, text);
      } else {
        assert.equal(out.length, 0);
      }
      return true;
    }),
  );
});

test("transcriptFromMessages regression: out-of-range numeric timestamps must not throw (Cardo)", () => {
  // Cardo regression: new Date(1e21).toISOString() threw RangeError, crashing
  // transcript building on corrupt/foreign JSONL.
  assert.deepEqual(
    transcriptFromMessages([{ role: "assistant", content: "hi", timestamp: 1e21 }], FALLBACK).map((i) => i.createdAt),
    [FALLBACK],
  );
  assert.deepEqual(
    transcriptFromMessages([{ role: "assistant", content: "hi", timestamp: -1e21 }], FALLBACK).map((i) => i.createdAt),
    [FALLBACK],
  );
  assert.deepEqual(
    transcriptFromMessages([{ role: "assistant", content: "hi", timestamp: Number.MAX_SAFE_INTEGER }], FALLBACK).map((i) => i.createdAt),
    [FALLBACK],
  );
  assert.equal(transcriptFromMessages([{ role: "assistant", content: "hi", timestamp: Number.NaN }], FALLBACK)[0]!.createdAt, FALLBACK);
});

test("PBT transcriptFromMessages: thinking parts yield one thinking item per assistant message, ahead of text/tools", () => {
  const thinkingPartArb = fc.record({
    type: fc.constant("thinking"),
    thinking: fc.string({ minLength: 0, maxLength: 40 }),
  });
  fc.assert(
    fc.property(
      fc.array(thinkingPartArb, { maxLength: 3 }),
      fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      (parts, id) => {
        const message = { role: "assistant", id, content: [...parts, { type: "text", text: "answer" }], createdAt: FALLBACK };
        const out = transcriptFromMessages([message], FALLBACK);
        const thinking = out.filter((item) => item.kind === "thinking");
        const qualifying = parts.filter((part) => part.thinking.trim().length > 0);
        assert.equal(thinking.length, Math.min(1, qualifying.length), "at most one thinking item per assistant message");
        if (qualifying.length > 0) {
          const item = thinking[0]!;
          assert.equal(item.kind, "thinking");
          assert.equal(item.text, qualifying.map((p) => p.thinking.trim()).join("\n\n"));
          assert.equal(item.createdAt, FALLBACK);
          if (typeof id === "string") {
            assert.equal(item.id, `${id}:thinking`);
          }
          const messageIndex = out.findIndex((entry) => entry.kind === "message");
          assert.ok(messageIndex > 0, "thinking item is emitted before the message text");
          assert.equal(out[messageIndex]!.kind, "message");
        } else {
          assert.equal(thinking.length, 0, "empty thinking parts yield no thinking item");
        }
        return true;
      },
    ),
  );
});

test("PBT transcriptFromMessages: thinking extraction never throws on arbitrary content arrays", () => {
  fc.assert(
    fc.property(fc.array(fc.anything(), { maxLength: 10 }), (content) => {
      const out = transcriptFromMessages([{ role: "assistant", content }], FALLBACK);
      for (const item of out) {
        if (item.kind === "thinking") {
          assert.equal(typeof item.text, "string");
        }
      }
      return true;
    }),
  );
});

test("transcriptFromMessages regression: thinking item counts are independent of tool/text items", () => {
  const out = transcriptFromMessages(
    [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step one" },
          { type: "text", text: "doing it" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
        createdAt: FALLBACK,
      },
    ],
    FALLBACK,
  );
  assert.deepEqual(
    out.map((item) => item.kind),
    ["thinking", "message", "tool"],
  );
  assert.equal((out[0] as Extract<SessionTranscriptItem, { kind: "thinking" }>).text, "step one");
});

test("transcriptFromMessages edge cases: non-records and unknown roles are skipped safely", () => {
  assert.deepEqual(transcriptFromMessages([null, undefined, 42, "text", { role: "weird" }], FALLBACK), []);
  // toolResult without toolCallId is skipped
  assert.deepEqual(transcriptFromMessages([{ role: "toolResult", content: "x" }], FALLBACK), []);
  // assistant with empty content yields nothing (text empty, no attachments)
  assert.deepEqual(transcriptFromMessages([{ role: "assistant", content: "" }], FALLBACK), []);
  assert.deepEqual(transcriptFromMessages([{ role: "user", content: [] }], FALLBACK), []);
});
