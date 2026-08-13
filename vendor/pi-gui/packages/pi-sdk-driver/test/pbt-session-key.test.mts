import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { sessionKey } from "../dist/session-supervisor-utils.js";

/**
 * sessionKey encodes a SessionRef as `${workspaceId}:${sessionId}`. The
 * `:`-delimited scheme is load-bearing: json-catalog-store persists
 * `sessionFiles[key]` and filters keys with `startsWith(`${workspaceId}:`)`,
 * so the format is part of the on-disk contract and cannot be changed lightly.
 *
 * Consequence: the encoding is injective only over refs whose ids contain no
 * `:` (the practical domain — pi generates colon-free session ids and
 * workspace paths rarely contain colons). Two refs with ids containing `:`
 * can collide (e.g. {a:b, c} vs {a, b:c} both yield "a:b:c"); this is a
 * documented limitation of the delimiter format, not an invariant we pin.
 * The properties below therefore generate ids from a colon-free alphabet.
 */

/** Session-id-like strings: letters, digits, `_`, `-` (never `:`). */
const idString = fc
  .array(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(""))), { maxLength: 48 })
  .map((chars) => chars.join(""));

const sessionRefArb = fc.record({
  workspaceId: idString,
  sessionId: idString,
});

test("PBT sessionKey: deterministic — same ref always maps to the same key", () => {
  fc.assert(
    fc.property(sessionRefArb, (ref) => {
      assert.equal(sessionKey(ref), sessionKey({ ...ref }));
      assert.equal(sessionKey(ref), sessionKey({ workspaceId: ref.workspaceId, sessionId: ref.sessionId }));
      return true;
    }),
  );
});

test("PBT sessionKey: injective over colon-free ids — distinct refs never share a key", () => {
  fc.assert(
    fc.property(sessionRefArb, sessionRefArb, (a, b) => {
      const sameRef = a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
      if (sameRef) {
        assert.equal(sessionKey(a), sessionKey(b));
      } else {
        assert.notEqual(sessionKey(a), sessionKey(b));
      }
      return true;
    }),
  );
});

test("PBT sessionKey: key is always a non-empty string containing both ids", () => {
  fc.assert(
    fc.property(sessionRefArb, (ref) => {
      const key = sessionKey(ref);
      assert.equal(typeof key, "string");
      assert.ok(key.length > 0, `key must be non-empty, got ${JSON.stringify(key)}`);
      assert.ok(key.includes(ref.workspaceId));
      assert.ok(key.includes(ref.sessionId));
      return true;
    }),
  );
});

test("sessionKey edge cases: empty and very long ids never throw", () => {
  assert.equal(sessionKey({ workspaceId: "", sessionId: "" }), ":");
  assert.equal(sessionKey({ workspaceId: "", sessionId: "abc" }), ":abc");
  assert.equal(sessionKey({ workspaceId: "ws", sessionId: "" }), "ws:");

  const long = "x".repeat(5000);
  const key = sessionKey({ workspaceId: long, sessionId: long });
  assert.equal(key, `${long}:${long}`);
  assert.equal(key.length, 2 * long.length + 1);
});

test("sessionKey edge cases: whitespace and unicode ids are preserved verbatim", () => {
  // ids are opaque strings; the key must round-trip them without loss
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", " ", "\t", "é", "中"), { maxLength: 20 }).map((c) => c.join("")),
      fc.array(fc.constantFrom("b", " ", "\n", "Ω", "日"), { maxLength: 20 }).map((c) => c.join("")),
      (ws, sid) => {
        const key = sessionKey({ workspaceId: ws, sessionId: sid });
        // parsing the key back out must recover the ids (delimiter-free ids only)
        const colon = key.indexOf(":");
        assert.equal(key.slice(0, colon), ws);
        assert.equal(key.slice(colon + 1), sid);
        return true;
      },
    ),
  );
});
