import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { extractPreview, messageText, previewFromSessionInfo, truncate } from "../dist/session-supervisor-utils.js";

const PREVIEW_LIMIT = 140;

const messageWithTextArb = fc.record({
  role: fc.constantFrom("user", "assistant"),
  content: fc.oneof(
    fc.array(fc.record({ type: fc.constant("text"), text: fc.string({ maxLength: 80 }) }), { maxLength: 4 }),
    fc.string({ maxLength: 80 }),
  ),
  stopReason: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  errorMessage: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
});

const sessionInfoArb = fc.record({
  firstMessage: fc.string({ maxLength: 400 }),
  allMessagesText: fc.string({ maxLength: 400 }),
});

test("PBT extractPreview: total over arbitrary input — never throws, undefined or string", () => {
  fc.assert(
    fc.property(fc.anything(), (input) => {
      const out = extractPreview(input);
      assert.ok(out === undefined || typeof out === "string");
      return true;
    }),
  );
});

test("PBT extractPreview: non-record input is undefined", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.integer(), fc.boolean()), (input) => {
      assert.equal(extractPreview(input), undefined);
      return true;
    }),
  );
});

test("PBT extractPreview: string results are capped at the truncate limit and normalized", () => {
  fc.assert(
    fc.property(fc.anything(), (input) => {
      const out = extractPreview(input);
      if (out !== undefined) {
        assert.ok(out.length <= PREVIEW_LIMIT, `preview length ${out.length} exceeds ${PREVIEW_LIMIT}`);
        assert.equal(out, out.trim());
        assert.ok(!/\s{2,}/.test(out), `preview must not contain whitespace runs: ${JSON.stringify(out)}`);
      }
      return true;
    }),
  );
});

test("PBT extractPreview: consistent with messageText — text-bearing records preview their text", () => {
  fc.assert(
    fc.property(messageWithTextArb, (message) => {
      const text = messageText(message);
      const out = extractPreview(message);
      if (text) {
        assert.equal(out, truncate(text));
      } else {
        // no text: falls through to stopReason + errorMessage
        if (typeof message.stopReason === "string" && typeof message.errorMessage === "string") {
          assert.equal(out, truncate(message.errorMessage));
        } else {
          assert.equal(out, undefined);
        }
      }
      return true;
    }),
  );
});

test("PBT previewFromSessionInfo: never throws, undefined or string capped at 140", () => {
  fc.assert(
    fc.property(sessionInfoArb, (info) => {
      const out = previewFromSessionInfo(info);
      assert.ok(out === undefined || typeof out === "string");
      if (out !== undefined) {
        assert.ok(out.length <= PREVIEW_LIMIT);
        assert.ok(!/\s{2,}/.test(out));
      }
      return true;
    }),
  );
});

test("PBT previewFromSessionInfo: matches the spec model (firstMessage wins, else allMessagesText)", () => {
  fc.assert(
    fc.property(sessionInfoArb, (info) => {
      const expected = truncate(info.firstMessage || info.allMessagesText, PREVIEW_LIMIT) || undefined;
      assert.equal(previewFromSessionInfo(info), expected);
      return true;
    }),
  );
});

test("extractPreview edge cases: empty text falls through to stopReason/errorMessage, else undefined", () => {
  assert.equal(extractPreview(null), undefined);
  assert.equal(extractPreview(undefined), undefined);
  assert.equal(extractPreview("hello"), undefined);
  assert.equal(extractPreview({}), undefined);
  assert.equal(extractPreview({ content: "" }), undefined);
  assert.equal(extractPreview({ content: "   \n " }), undefined);
  // text wins over stopReason
  assert.equal(extractPreview({ role: "assistant", content: "answer", stopReason: "error", errorMessage: "boom" }), "answer");
  // no text, stopReason + errorMessage -> preview of the error message
  assert.equal(extractPreview({ role: "assistant", stopReason: "error", errorMessage: "boom" }), "boom");
  // stopReason without errorMessage -> undefined
  assert.equal(extractPreview({ role: "assistant", stopReason: "error" }), undefined);
  // non-string stopReason / errorMessage -> undefined
  assert.equal(extractPreview({ role: "assistant", stopReason: "error", errorMessage: 42 }), undefined);
  assert.equal(extractPreview({ role: "assistant", stopReason: 42, errorMessage: "boom" }), undefined);
});

test("previewFromSessionInfo edge cases: empty strings yield undefined, long text is truncated", () => {
  assert.equal(previewFromSessionInfo({ firstMessage: "", allMessagesText: "" }), undefined);
  assert.equal(previewFromSessionInfo({ firstMessage: "   ", allMessagesText: "" }), undefined);
  assert.equal(previewFromSessionInfo({ firstMessage: "", allMessagesText: "fallback" }), "fallback");
  assert.equal(previewFromSessionInfo({ firstMessage: "first", allMessagesText: "fallback" }), "first");

  const long = "x".repeat(300);
  const out = previewFromSessionInfo({ firstMessage: long, allMessagesText: "" });
  assert.ok(out !== undefined);
  assert.equal(out!.length, PREVIEW_LIMIT);
  assert.ok(out!.endsWith("…"));
});
