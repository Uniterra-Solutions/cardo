import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_SCHEMA_VERSION,
  buildSessionSchemaInfo,
  readSessionFileSchemaVersion,
  schemaVersionFromHeaderLine,
} from "../dist/session-schema.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-pbt-schema-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const versionArb = fc.option(fc.integer(), { nil: undefined });

test("PBT buildSessionSchemaInfo: fileSchemaVersion round-trips and newer-flag is exact", () => {
  fc.assert(
    fc.property(versionArb, (version) => {
      const info = buildSessionSchemaInfo(version);
      assert.equal(info.fileSchemaVersion, version);
      assert.equal(info.runtimeSchemaVersion, RUNTIME_SCHEMA_VERSION);
      assert.equal(info.writtenByNewerRuntime, version !== undefined && version > RUNTIME_SCHEMA_VERSION);
      return true;
    }),
  );
});

test("PBT schemaVersionFromHeaderLine: never throws on any string", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (line) => {
      const out = schemaVersionFromHeaderLine(line);
      assert.ok(out === undefined || typeof out === "number");
      return true;
    }),
  );
});

test("PBT schemaVersionFromHeaderLine: session header with numeric version round-trips", () => {
  fc.assert(
    fc.property(fc.integer(), (version) => {
      assert.equal(schemaVersionFromHeaderLine(JSON.stringify({ type: "session", id: "s", version })), version);
      return true;
    }),
  );
});

test("PBT schemaVersionFromHeaderLine: non-session or non-object JSON is undefined, missing version defaults to 1", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("message", "custom", "compaction", ""),
      fc.oneof(fc.string(), fc.boolean(), fc.array(fc.anything(), { maxLength: 3 })),
      (type, payload) => {
        // a JSON object whose type is not "session" never yields a version
        assert.equal(schemaVersionFromHeaderLine(JSON.stringify({ type, version: 5 })), undefined);
        // header with no version is treated as v1
        assert.equal(schemaVersionFromHeaderLine(JSON.stringify({ type: "session", id: "s" })), 1);
        // non-numeric version payload is treated as v1
        assert.equal(schemaVersionFromHeaderLine(JSON.stringify({ type: "session", version: payload })), 1);
        return true;
      },
    ),
  );
});

test("PBT schemaVersionFromHeaderLine: non-object JSON values never yield a version", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.anything(), { maxLength: 4 })), (value) => {
      assert.equal(schemaVersionFromHeaderLine(JSON.stringify(value)), undefined);
      return true;
    }),
  );
});

test("PBT readSessionFileSchemaVersion: header round-trips through a real file", async () => {
  await fc.assert(
    fc.asyncProperty(versionArb, async (version) => {
      await withTempDir(async (dir) => {
        const file = join(dir, "s.jsonl");
        const header: Record<string, unknown> = { type: "session", id: "abc", cwd: "/x", timestamp: "2026-01-01T00:00:00Z" };
        if (version !== undefined) {
          header.version = version;
        }
        await writeFile(file, `${JSON.stringify(header)}\n{"type":"message","role":"user"}\n`);
        assert.equal(await readSessionFileSchemaVersion(file), version === undefined ? 1 : version);
      });
    }),
  );
});

test("PBT readSessionFileSchemaVersion: arbitrary file contents never throw and yield number | undefined", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 300 }), async (content) => {
      await withTempDir(async (dir) => {
        const file = join(dir, "s.jsonl");
        await writeFile(file, content);
        const out = await readSessionFileSchemaVersion(file);
        assert.ok(out === undefined || typeof out === "number");
      });
    }),
  );
});

test("session-schema edge cases: boundary versions around the runtime version", () => {
  const info = buildSessionSchemaInfo(RUNTIME_SCHEMA_VERSION);
  assert.equal(info.writtenByNewerRuntime, false);
  assert.equal(buildSessionSchemaInfo(RUNTIME_SCHEMA_VERSION + 1).writtenByNewerRuntime, true);
  assert.equal(buildSessionSchemaInfo(RUNTIME_SCHEMA_VERSION - 1).writtenByNewerRuntime, false);
  assert.equal(buildSessionSchemaInfo(undefined).writtenByNewerRuntime, false);

  // NaN is not a number comparison — newer-flag stays false, version is NaN
  const nanInfo = buildSessionSchemaInfo(Number.NaN);
  assert.ok(Number.isNaN(nanInfo.fileSchemaVersion));
  assert.equal(nanInfo.writtenByNewerRuntime, false);
});

test("session-schema edge cases: corrupt JSON and empty lines yield undefined", () => {
  assert.equal(schemaVersionFromHeaderLine(""), undefined);
  assert.equal(schemaVersionFromHeaderLine("{ not json"), undefined);
  assert.equal(schemaVersionFromHeaderLine("null"), undefined);
  assert.equal(schemaVersionFromHeaderLine("[1,2,3]"), undefined);
  assert.equal(schemaVersionFromHeaderLine('{"type":"session","version":"4"}'), 1, "non-numeric version defaults to 1");
});
