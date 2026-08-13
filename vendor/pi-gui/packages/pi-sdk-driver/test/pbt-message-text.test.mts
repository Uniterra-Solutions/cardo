import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { messageText } from "../dist/session-supervisor-utils.js";

const textPartArb = fc.record({ type: fc.constant("text"), text: fc.string({ maxLength: 60 }) });
const thinkingPartArb = fc.record({ type: fc.constant("thinking"), thinking: fc.string({ maxLength: 60 }) });
const otherPartArb = fc.record({
  type: fc.constantFrom("image", "toolCall", "refusal", "function_call", "weird"),
  text: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
});
const contentPartsArb = fc.array(fc.oneof(textPartArb, thinkingPartArb, otherPartArb), { maxLength: 8 });

/** User text that cannot collide with the serialized-file-attachment preamble. */
const safeUserString = fc
  .array(fc.constantFrom("a", "b", "c", " ", "\t"), { maxLength: 40 })
  .map((chars) => chars.join(""));

const recordMessageArb = fc.record({
  role: fc.constantFrom("user", "assistant", "branchSummary", "compactionSummary", "toolResult", "system"),
  content: fc.oneof(fc.string({ maxLength: 60 }), contentPartsArb),
  summary: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
});

test("PBT messageText: total over arbitrary input — never throws, always a string", () => {
  fc.assert(
    fc.property(fc.anything(), (input) => {
      const out = messageText(input);
      assert.equal(typeof out, "string");
      return true;
    }),
  );
});

test("PBT messageText: non-record input maps to the empty string", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.integer(), fc.boolean(), fc.bigInt()), (input) => {
      assert.equal(messageText(input), "");
      return true;
    }),
  );
});

test("PBT messageText: string content is returned as-is (trimmed) for assistant", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (s) => {
      assert.equal(messageText({ role: "assistant", content: s }), s.trim());
      return true;
    }),
  );
});

test("PBT messageText: user string content (outside the attachment-preamble domain) is trimmed", () => {
  fc.assert(
    fc.property(safeUserString, (s) => {
      assert.equal(messageText({ role: "user", content: s }), s.trim());
      return true;
    }),
  );
});

test("PBT messageText: array of text blocks concatenates in order, empty blocks dropped", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ type: fc.constant("text"), text: fc.string({ maxLength: 40 }) }), { maxLength: 6 }), (parts) => {
      const expected = parts
        .map((p) => p.text)
        .filter((t) => t.length > 0)
        .join("\n\n")
        .trim();
      assert.equal(messageText({ role: "assistant", content: parts }), expected);
      return true;
    }),
  );
});

test("PBT messageText: thinking blocks are excluded, text parts still join in order", () => {
  // Disjoint charsets: text parts use letters, thinking uses digits, so the
  // thinking text can never leak into output by coincidence.
  const lettersPart = fc.record({ type: fc.constant("text"), text: fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 30 }).map((c) => c.join("")) });
  const digitsThinking = fc.array(fc.constantFrom("1", "2", "3"), { maxLength: 30 }).map((c) => c.join(""));
  fc.assert(
    fc.property(fc.array(fc.oneof(lettersPart, fc.record({ type: fc.constant("thinking"), thinking: fc.string({ maxLength: 30 }) })), { maxLength: 6 }), digitsThinking, (parts, thinking) => {
      const message = {
        role: "assistant",
        content: [...parts, { type: "thinking", thinking }],
      };
      const out = messageText(message);
      const expected = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .filter((t) => t.length > 0)
        .join("\n\n")
        .trim();
      assert.equal(out, expected, "thinking parts must contribute nothing to the text");
      if (thinking.length > 0) {
        assert.ok(!out.includes(thinking), `thinking text must never appear in output: ${JSON.stringify(out)}`);
      }
      return true;
    }),
  );
});

test("PBT messageText: branchSummary / compactionSummary use summary, trimmed", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("branchSummary", "compactionSummary"),
      fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
      (role, summary) => {
        const expected = typeof summary === "string" ? summary.trim() : "";
        assert.equal(messageText({ role, summary }), expected);
        // content is ignored for summary roles
        assert.equal(messageText({ role, summary, content: "ignored" }), expected);
        return true;
      },
    ),
  );
});

test("PBT messageText: records without content, or with only non-text parts, yield empty string", () => {
  fc.assert(
    fc.property(recordMessageArb, (message) => {
      const out = messageText(message);
      assert.equal(typeof out, "string");
      if (message.role !== "branchSummary" && message.role !== "compactionSummary") {
        const content = message.content;
        const hasTextPart =
          Array.isArray(content) &&
          content.some((p) => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string" && (p as { text: string }).text.length > 0);
        if (!hasTextPart && !(typeof content === "string" && content.trim().length > 0)) {
          assert.equal(out, "");
        }
      }
      return true;
    }),
  );
});

test("messageText edge cases: null / undefined / primitives (Cardo regression: used to throw TypeError)", () => {
  assert.equal(messageText(null), "");
  assert.equal(messageText(undefined), "");
  assert.equal(messageText("plain string"), "");
  assert.equal(messageText(42), "");
  assert.equal(messageText(true), "");
  assert.equal(messageText([]), ""); // empty array is a record but has no content
  assert.equal(messageText({}), "");
});

test("messageText edge cases: mixed blocks join exactly as the existing unit test pins", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: "A" },
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "" },
      { type: "text", text: "B" },
    ],
  };
  assert.equal(messageText(message), "A\n\nB");
});
