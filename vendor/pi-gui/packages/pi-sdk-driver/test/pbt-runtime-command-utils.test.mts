import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { normalizeRuntimeCommandName, skillCommandName, skillSlashCommand } from "../dist/runtime-command-utils.js";

/** Names with leading slashes, whitespace padding, and interior whitespace. */
const messyNameArb = fc
  .array(fc.constantFrom("/", " ", "\t", "a", "b", "c", "-", "_"), { maxLength: 40 })
  .map((chars) => chars.join(""));

const anyNameArb = fc.string({ maxLength: 60 });

test("PBT normalizeRuntimeCommandName: idempotent — applying twice equals applying once", () => {
  fc.assert(
    fc.property(anyNameArb, (name) => {
      const once = normalizeRuntimeCommandName(name);
      assert.equal(normalizeRuntimeCommandName(once), once);
      return true;
    }),
  );
});

test("PBT normalizeRuntimeCommandName: result is trimmed and free of leading slashes", () => {
  fc.assert(
    fc.property(anyNameArb, (name) => {
      const out = normalizeRuntimeCommandName(name);
      assert.equal(out, out.trim(), `result must be trimmed: ${JSON.stringify(out)}`);
      assert.ok(!out.startsWith("/"), `result must not start with '/': ${JSON.stringify(out)}`);
      // stable under repeated calls
      assert.equal(normalizeRuntimeCommandName(out), out);
      return true;
    }),
  );
});

test("PBT normalizeRuntimeCommandName: leading slashes and padding are stripped, interior content kept", () => {
  fc.assert(
    fc.property(messyNameArb, (name) => {
      const out = normalizeRuntimeCommandName(name);
      // exact semantics: trim, strip all leading slashes, trim again (the
      // trailing trim keeps normalization idempotent)
      const expected = name.trim().replace(/^\/+/, "").trim();
      assert.equal(out, expected);
      return true;
    }),
  );
});

test("PBT skillCommandName: deterministic slash-prefixed skill names", () => {
  fc.assert(
    fc.property(anyNameArb, (name) => {
      const out = skillCommandName(name);
      assert.equal(out, `skill:${normalizeRuntimeCommandName(name)}`);
      assert.equal(out, skillCommandName(name), "deterministic");
      assert.equal(skillCommandName(normalizeRuntimeCommandName(name)), out, "normalizes internally");
      assert.ok(!out.startsWith("/"));
      return true;
    }),
  );
});

test("PBT skillCommandName: equal names iff equal normalized names", () => {
  fc.assert(
    fc.property(anyNameArb, anyNameArb, (a, b) => {
      assert.equal(
        skillCommandName(a) === skillCommandName(b),
        normalizeRuntimeCommandName(a) === normalizeRuntimeCommandName(b),
      );
      return true;
    }),
  );
});

test("PBT skillSlashCommand: slash-prefixed form of skillCommandName", () => {
  fc.assert(
    fc.property(anyNameArb, (name) => {
      const out = skillSlashCommand(name);
      assert.equal(out, `/${skillCommandName(name)}`);
      assert.ok(out.startsWith("/skill:"));
      assert.equal(skillSlashCommand(normalizeRuntimeCommandName(name)), out);
      return true;
    }),
  );
});

test("runtime-command-utils edge cases: empty, whitespace-only, and slash-only names", () => {
  assert.equal(normalizeRuntimeCommandName(""), "");
  assert.equal(normalizeRuntimeCommandName("   \t\n"), "");
  assert.equal(normalizeRuntimeCommandName("/"), "");
  assert.equal(normalizeRuntimeCommandName("///"), "");
  assert.equal(normalizeRuntimeCommandName("  /  "), "");
  assert.equal(normalizeRuntimeCommandName("/foo"), "foo");
  assert.equal(normalizeRuntimeCommandName("  //foo/bar  "), "foo/bar");
  assert.equal(normalizeRuntimeCommandName("foo/bar"), "foo/bar", "interior slashes are preserved");

  assert.equal(skillCommandName(""), "skill:");
  assert.equal(skillCommandName("/"), "skill:");
  assert.equal(skillCommandName("  /my-skill "), "skill:my-skill");
  assert.equal(skillSlashCommand("  /my-skill "), "/skill:my-skill");
});

test("normalizeRuntimeCommandName regression: idempotent for slash-then-whitespace input (Cardo)", () => {
  // Cardo regression: "/ x" normalized to " x", and " x" normalized to "x",
  // so normalize-twice !== normalize-once.
  const cases = ["/ x", "/ !", "/ foo", "// \tbar", "/   ", " / a / b "];
  for (const input of cases) {
    const once = normalizeRuntimeCommandName(input);
    assert.equal(normalizeRuntimeCommandName(once), once, `idempotency failed for ${JSON.stringify(input)}`);
  }
  assert.equal(normalizeRuntimeCommandName("/ x"), "x");
  assert.equal(normalizeRuntimeCommandName("/ !"), "!");
  assert.equal(normalizeRuntimeCommandName("  /  "), "");
});
