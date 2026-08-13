import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { mapToRecord } from "../../out-pbt/desktop/electron/app-store-utils.js";

test("pbt smoke: mapToRecord preserves every key/value from a Map", () => {
  fc.assert(
    fc.property(fc.uniqueArray(fc.tuple(fc.string(), fc.integer()), { selector: (p) => p[0] }), (pairs) => {
      const map = new Map(pairs);
      const record = mapToRecord(map);
      for (const [key, value] of pairs) {
        assert.equal(record[key], value);
      }
      assert.equal(Object.keys(record).length, map.size);
    }),
    { numRuns: 100 },
  );
});
