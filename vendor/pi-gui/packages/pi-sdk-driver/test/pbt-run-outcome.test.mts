import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { determineRunOutcome } from "../dist/session-supervisor-utils.js";

/**
 * determineRunOutcome scans messages from the END and considers only the
 * LATEST assistant record: if its stopReason is "error"/"aborted" the run
 * failed (code = uppercase stopReason), otherwise it succeeded — earlier
 * assistant failures are ignored.
 */
function specRunOutcome(messages: readonly unknown[]): { success: boolean; error?: { message: string; code: string } } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message !== "object" || message === null || (message as Record<string, unknown>).role !== "assistant") {
      continue;
    }
    const record = message as Record<string, unknown>;
    const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      const errorMessage =
        typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0
          ? record.errorMessage
          : stopReason === "aborted"
            ? "Run aborted"
            : "Run failed";
      return { success: false, error: { message: errorMessage, code: stopReason.toUpperCase() } };
    }
    break;
  }
  return { success: true };
}

const assistantArb = fc.record({
  role: fc.constant("assistant"),
  stopReason: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  errorMessage: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
});

const anyMessageArb = fc.oneof(
  assistantArb,
  fc.record({ role: fc.constantFrom("user", "toolResult", "system", "branchSummary"), stopReason: fc.option(fc.string(), { nil: undefined }) }),
  fc.anything(),
);

test("PBT determineRunOutcome: never throws on arbitrary message arrays", () => {
  fc.assert(
    fc.property(fc.array(fc.anything(), { maxLength: 15 }), (messages) => {
      const out = determineRunOutcome(messages);
      assert.equal(typeof out.success, "boolean");
      return true;
    }),
  );
});

test("PBT determineRunOutcome: matches the spec — outcome depends only on the latest assistant message", () => {
  fc.assert(
    fc.property(fc.array(anyMessageArb, { maxLength: 12 }), (messages) => {
      assert.deepEqual(determineRunOutcome(messages), specRunOutcome(messages));
      return true;
    }),
  );
});

test("PBT determineRunOutcome: failure carries an uppercase error code and a non-empty message", () => {
  fc.assert(
    fc.property(fc.array(anyMessageArb, { maxLength: 12 }), (messages) => {
      const out = determineRunOutcome(messages);
      if (out.success === false) {
        assert.ok(out.error, "failure must carry error info");
        assert.equal(out.error!.code, out.error!.code.toUpperCase());
        assert.ok(out.error!.message.length > 0);
      } else {
        assert.equal(out.error, undefined);
      }
      return true;
    }),
  );
});

test("determineRunOutcome edge cases: empty input, non-records, no assistants => success", () => {
  assert.deepEqual(determineRunOutcome([]), { success: true });
  assert.deepEqual(determineRunOutcome([null, undefined, 42, "x"]), { success: true });
  assert.deepEqual(determineRunOutcome([{ role: "user", stopReason: "error" }]), { success: true });
  assert.deepEqual(determineRunOutcome([{ stopReason: "error" }]), { success: true }, "records without role assistant are ignored");
});

test("determineRunOutcome edge cases: only the latest assistant decides, error/aborted map to uppercase codes", () => {
  // earlier assistant failure is ignored when a later assistant succeeded
  assert.deepEqual(
    determineRunOutcome([
      { role: "assistant", stopReason: "error", errorMessage: "old failure" },
      { role: "assistant", stopReason: "stop" },
    ]),
    { success: true },
  );
  // non-assistant trailing records don't hide the latest assistant failure
  assert.deepEqual(
    determineRunOutcome([
      { role: "assistant", stopReason: "error", errorMessage: "boom" },
      { role: "user", content: "hi" },
      { role: "toolResult", toolCallId: "t1" },
    ]),
    { success: false, error: { message: "boom", code: "ERROR" } },
  );
  assert.deepEqual(determineRunOutcome([{ role: "assistant", stopReason: "aborted" }]), {
    success: false,
    error: { message: "Run aborted", code: "ABORTED" },
  });
  assert.deepEqual(determineRunOutcome([{ role: "assistant", stopReason: "error" }]), {
    success: false,
    error: { message: "Run failed", code: "ERROR" },
  });
  assert.deepEqual(determineRunOutcome([{ role: "assistant", stopReason: "error", errorMessage: "   " }]), {
    success: false,
    error: { message: "Run failed", code: "ERROR" },
  });
  // non-string stopReason values never count as failure
  assert.deepEqual(determineRunOutcome([{ role: "assistant", stopReason: 42 }]), { success: true });
  assert.deepEqual(determineRunOutcome([{ role: "assistant" }]), { success: true });
});
