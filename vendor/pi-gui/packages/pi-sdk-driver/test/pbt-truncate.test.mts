import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { truncate } from "../dist/session-supervisor-utils.js";

/** Strings rich in whitespace runs (spaces, tabs, newlines). */
const messyString = fc
  .array(fc.constantFrom("a", "b", "c", " ", "\t", "\n", "\r", "\v", "\f"), { maxLength: 120 })
  .map((chars) => chars.join(""));
const plainString = fc.string({ maxLength: 120 });
const limitArb = fc.integer({ min: 0, max: 200 });

/** The truncate contract, stated independently: normalize, then hard-truncate at `limit` with an ellipsis. */
function specTruncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (limit <= 0) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

test("PBT truncate: output length never exceeds the limit for any limit >= 0", () => {
  fc.assert(
    fc.property(messyString, limitArb, (value, limit) => {
      const out = truncate(value, limit);
      assert.equal(typeof out, "string");
      assert.ok(out.length <= limit, `truncate(${JSON.stringify(value)}, ${limit}) => len ${out.length} > ${limit}`);
      return true;
    }),
  );
});

test("PBT truncate: matches the spec model exactly (normalize + ellipsis truncation)", () => {
  fc.assert(
    fc.property(messyString, limitArb, (value, limit) => {
      assert.equal(truncate(value, limit), specTruncate(value, limit));
      return true;
    }),
  );
});

test("PBT truncate: output is whitespace-normalized — trimmed, no runs of whitespace", () => {
  fc.assert(
    fc.property(messyString, limitArb, (value, limit) => {
      const out = truncate(value, limit);
      assert.equal(out, out.trim(), `output must be trimmed: ${JSON.stringify(out)}`);
      assert.ok(!/\s{2,}/.test(out), `output must not contain whitespace runs: ${JSON.stringify(out)}`);
      return true;
    }),
  );
});

test("PBT truncate: already-normalized short input is returned unchanged", () => {
  fc.assert(
    fc.property(messyString, limitArb, (value, limit) => {
      const normalized = value.replace(/\s+/g, " ").trim();
      if (normalized.length <= limit) {
        assert.equal(truncate(value, limit), normalized);
      }
      return true;
    }),
  );
});

test("PBT truncate: idempotent — truncating the output again is a no-op", () => {
  fc.assert(
    fc.property(messyString, limitArb, (value, limit) => {
      const once = truncate(value, limit);
      assert.equal(truncate(once, limit), once);
      return true;
    }),
  );
});

test("PBT truncate: ellipsized output is a prefix of the normalized value, length exactly limit", () => {
  fc.assert(
    fc.property(messyString, fc.integer({ min: 1, max: 200 }), (value, limit) => {
      const out = truncate(value, limit);
      const normalized = value.replace(/\s+/g, " ").trim();
      if (out !== normalized) {
        assert.ok(out.endsWith("…"), `truncated output must end with ellipsis: ${JSON.stringify(out)}`);
        assert.equal(out.length, limit, "ellipsized output must have length exactly limit");
        assert.equal(out.slice(0, -1), normalized.slice(0, limit - 1));
      }
      return true;
    }),
  );
});

test("PBT truncate: plain (already normalized) strings behave identically", () => {
  fc.assert(
    fc.property(plainString, limitArb, (value, limit) => {
      assert.equal(truncate(value, limit), specTruncate(value, limit));
      return true;
    }),
  );
});

test("truncate edge cases: empty and whitespace-only input", () => {
  assert.equal(truncate(""), "");
  assert.equal(truncate("   \t\n  "), "");
  assert.equal(truncate("", 0), "");
  assert.equal(truncate("   ", 0), "");
  assert.equal(truncate("", 1), "");
  assert.equal(truncate("", 5), "");
});

test("truncate edge cases: exact-length input is unchanged; one over truncates to ellipsis", () => {
  assert.equal(truncate("abcde", 5), "abcde");
  assert.equal(truncate("abcdef", 5), "abcd…");
  assert.equal(truncate("a", 1), "a");
  assert.equal(truncate("ab", 1), "…");
});

test("truncate regression: limit 0 must never produce a string longer than the limit", () => {
  // Cardo regression: slice(0, limit - 1) underflowed when limit === 0,
  // returning "a…" (length 2) for truncate("ab", 0).
  assert.equal(truncate("ab", 0), "");
  assert.equal(truncate("abcde", 0), "");
  assert.equal(truncate("a", 0), "");
  assert.equal(truncate("hello world", 0), "");
  assert.equal(truncate("hello world", 0).length, 0);
});
