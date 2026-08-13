/**
 * Property-based tests for the persistence layer of the pi-gui desktop app:
 *  - electron/app-store-persistence.ts  (readPersistedUiState / writePersistedUiState)
 *  - electron/atomic-file-write.ts      (writeFileAtomicQueued / readJsonWithBackup)
 *  - electron/json-file-store.ts        (JsonFileStore)
 *
 * Compiled under tsconfig.pbt.json into out-pbt/; run via `pnpm run test:pbt`.
 *
 * Invariants under test:
 *  1. write → read roundtrip: every field the reader preserves comes back equal;
 *     a freshly written file parses back without corruption.
 *  2. Corruption tolerance: garbage bytes never throw — readPersistedUiState
 *     returns an object, readJsonWithBackup flags corrupted:true, and a valid
 *     `.bak` sibling is recovered transparently.
 *  3. JsonFileStore read→write→read roundtrip for arbitrary JSON payloads and
 *     keys; missing entries resolve to undefined without throwing.
 *  4. writeFileAtomicQueued: sequential and concurrent queued writes always
 *     land fully and in order; the previous good version is promoted to `.bak`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readPersistedUiState,
  writePersistedUiState,
} from "../../out-pbt/desktop/electron/app-store-persistence.js";
import {
  readJsonWithBackup,
  writeFileAtomicQueued,
} from "../../out-pbt/desktop/electron/atomic-file-write.js";
import { JsonFileStore } from "../../out-pbt/desktop/electron/json-file-store.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cardo-pbt-persistence-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

function isParseableJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

const invalidJsonArb = fc
  .string({ maxLength: 256 })
  .filter((raw) => !isParseableJson(raw));

const nonEmptyString = fc.string({ minLength: 1, maxLength: 64 });

/** Non-empty record of non-empty strings (fc.dictionary cannot guarantee minLength). */
const nonEmptyStringRecord = fc
  .uniqueArray(fc.tuple(nonEmptyString, nonEmptyString), {
    minLength: 1,
    maxLength: 8,
    selector: ([key]) => key,
  })
  .map((pairs) => Object.fromEntries(pairs));

// ---------------------------------------------------------------------------
// arbitrary PersistedUiState-shaped values.
// Every field is generated in the exact shape the reader preserves (validated
// enums, non-empty strings where the reader drops empty values, orchestration
// transcripts/evidence inside the reader's retention limits), so the roundtrip
// property can assert deep equality without mirroring normalization logic.
// ---------------------------------------------------------------------------

const validVersionArb = fc.constantFrom(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);

const modelSettingsArb = fc.record({
  defaultProvider: fc.option(fc.string(), { nil: undefined }),
  defaultModelId: fc.option(fc.string(), { nil: undefined }),
  defaultThinkingLevel: fc.option(fc.string(), { nil: undefined }),
  enabledModelPatterns: fc.array(fc.string()),
});

const orchestrationTranscriptMessageArb = fc.record({
  id: nonEmptyString,
  role: fc.constantFrom("parent" as const, "child" as const, "system" as const),
  text: nonEmptyString,
  createdAt: nonEmptyString,
});

const orchestrationEvidenceGitArb = fc.record({
  workspaceId: nonEmptyString,
  branchName: fc.option(nonEmptyString, { nil: undefined }),
  headSha: fc.option(nonEmptyString, { nil: undefined }),
});

const orchestrationEvidenceArb = fc.record({
  id: nonEmptyString,
  kind: fc.constantFrom(
    "worker_report" as const,
    "orchestrator_acceptance" as const,
    "orchestrator_observation" as const,
    "orchestrator_action" as const,
    "command" as const,
    "review_finding" as const,
    "blocker" as const,
  ),
  source: fc.constantFrom(
    "worker-reported" as const,
    "orchestrator-accepted" as const,
    "orchestrator-observed" as const,
    "orchestrator-action" as const,
    "command" as const,
    "review" as const,
    "blocker" as const,
  ),
  status: fc.constantFrom("reported" as const, "accepted" as const, "running" as const, "passed" as const, "failed" as const, "blocked" as const),
  title: nonEmptyString,
  detail: fc.option(nonEmptyString, { nil: undefined }),
  command: fc.option(nonEmptyString, { nil: undefined }),
  toolName: fc.option(nonEmptyString, { nil: undefined }),
  severity: fc.option(fc.constantFrom("P0" as const, "P1" as const, "P2" as const, "P3" as const), { nil: undefined }),
  parentSessionId: fc.option(nonEmptyString, { nil: undefined }),
  childSessionId: fc.option(nonEmptyString, { nil: undefined }),
  git: fc.option(orchestrationEvidenceGitArb, { nil: undefined }),
  createdAt: nonEmptyString,
  updatedAt: fc.option(nonEmptyString, { nil: undefined }),
});

const supervisionLoopArb = fc.record({
  id: nonEmptyString,
  status: fc.constantFrom("monitoring" as const, "attention" as const, "stopped" as const),
  gate: fc.constantFrom("continue" as const, "stop" as const, "wake" as const),
  intervalMs: fc.integer({ min: 1, max: 60_000 }),
  iterationCount: fc.integer({ min: 0, max: 1000 }),
  lastCheckedAt: nonEmptyString,
  nextRunAt: fc.option(nonEmptyString, { nil: undefined }),
  reason: nonEmptyString,
  lastChildStatus: fc.option(fc.constantFrom("queued" as const, "running" as const, "waiting" as const, "complete" as const, "failed" as const), { nil: undefined }),
  stoppedAt: fc.option(nonEmptyString, { nil: undefined }),
});

const orchestrationChildArb = fc.record({
  id: nonEmptyString,
  sourceToolCallId: fc.option(nonEmptyString, { nil: undefined }),
  parentWorkspaceId: nonEmptyString,
  parentSessionId: nonEmptyString,
  childWorkspaceId: nonEmptyString,
  childSessionId: nonEmptyString,
  title: nonEmptyString,
  goal: nonEmptyString,
  status: fc.constantFrom("queued" as const, "running" as const, "waiting" as const, "complete" as const, "failed" as const),
  latestTranscript: nonEmptyString,
  // Keep within the reader's retention limits so the roundtrip is exact:
  // MAX_PERSISTED_ORCHESTRATION_TRANSCRIPT_MESSAGES = 40,
  // MAX_PERSISTED_ORCHESTRATION_EVIDENCE_RECORDS = 80.
  transcript: fc.array(orchestrationTranscriptMessageArb, { maxLength: 40 }),
  evidence: fc.array(orchestrationEvidenceArb, { maxLength: 80 }),
  supervisionLoop: fc.option(supervisionLoopArb, { nil: undefined }),
  createdAt: nonEmptyString,
  updatedAt: nonEmptyString,
});

const persistedUiStateArb = fc.record({
  version: fc.option(validVersionArb, { nil: undefined }),
  selectedWorkspaceId: fc.option(fc.string(), { nil: undefined }),
  selectedSessionId: fc.option(fc.string(), { nil: undefined }),
  activeView: fc.option(fc.string(), { nil: undefined }),
  composerDraft: fc.option(fc.string(), { nil: undefined }),
  composerDraftsBySession: fc.option(fc.dictionary(fc.string(), fc.string()), { nil: undefined }),
  extensionCommandCompatibilityByWorkspace: fc.option(
    fc.dictionary(fc.string(), fc.array(fc.jsonValue(), { maxLength: 4 })),
    { nil: undefined },
  ),
  notificationPreferences: fc.option(
    fc.record({
      backgroundCompletion: fc.boolean(),
      backgroundFailure: fc.boolean(),
      attentionNeeded: fc.boolean(),
    }),
    { nil: undefined },
  ),
  integratedTerminalShell: fc.option(fc.string(), { nil: undefined }),
  lastViewedAtBySession: fc.option(fc.dictionary(fc.string(), fc.string()), { nil: undefined }),
  // toStringRecord drops empty-string values and collapses empty records to
  // undefined; generate non-empty, non-empty-value records only.
  pinnedAtBySession: fc.option(nonEmptyStringRecord, { nil: undefined }),
  pinnedSessionOrder: fc.option(fc.array(fc.string()), { nil: undefined }),
  workspaceOrder: fc.option(fc.array(fc.string()), { nil: undefined }),
  modelSettingsScopeMode: fc.option(fc.constantFrom("per-repo" as const, "app-global" as const), { nil: undefined }),
  appGlobalModelSettings: fc.option(modelSettingsArb, { nil: undefined }),
  sidebarCollapsed: fc.option(fc.boolean(), { nil: undefined }),
  allowMultiple: fc.option(fc.boolean(), { nil: undefined }),
  enableTransparency: fc.option(fc.boolean(), { nil: undefined }),
  themeMode: fc.option(fc.constantFrom("system" as const, "light" as const, "dark" as const), { nil: undefined }),
  themePresetId: fc.option(
    fc.constantFrom(
      "default" as const,
      "catppuccin" as const,
      "tokyo-night" as const,
      "nord" as const,
      "dracula" as const,
      "gruvbox" as const,
      "github" as const,
      "vscode" as const,
    ),
    { nil: undefined },
  ),
  orchestrationChildren: fc.option(fc.array(orchestrationChildArb, { maxLength: 4 }), { nil: undefined }),
  composerAttachmentsBySession: fc.option(fc.dictionary(fc.string(), fc.array(fc.jsonValue(), { maxLength: 4 })), { nil: undefined }),
  transcripts: fc.option(fc.dictionary(fc.string(), fc.array(fc.jsonValue(), { maxLength: 4 })), { nil: undefined }),
});

/**
 * The reader's toPersistedOrchestrationChildren injects `childThreadId` into
 * every evidence record (from the enclosing child thread id), and its
 * toPersistedSupervisionLoop substitutes the child thread's status whenever
 * lastChildStatus is absent/invalid. Reflect both in the expected value so the
 * roundtrip assertion encodes the reader's contract.
 */
function canonicalizeChildThread(child: {
  id: string;
  status: string;
  evidence?: readonly { childThreadId?: string }[];
  supervisionLoop?: { lastChildStatus?: string } | undefined;
}): Record<string, unknown> {
  return {
    ...child,
    evidence: (child.evidence ?? []).map((evidence) => ({ ...evidence, childThreadId: child.id })),
    supervisionLoop: child.supervisionLoop
      ? {
          ...child.supervisionLoop,
          lastChildStatus: child.supervisionLoop.lastChildStatus ?? child.status,
        }
      : undefined,
  };
}

/**
 * Normalize a value the way a JSON file roundtrip does: plain objects, no
 * null-prototype dictionaries (fast-check's fc.dictionary builds records with
 * a null prototype), undefined dropped from object values. This is applied to
 * expected values so they match what the reader produces after JSON.parse.
 */
function normalizeJson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

/** Expected roundtrip value: writer pins version 15, reader defaults composerDraft to "". */
function expectedRoundtrip(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    version: 15,
    composerDraft: (input.composerDraft as string | undefined) ?? "",
    orchestrationChildren: Array.isArray(input.orchestrationChildren)
      ? input.orchestrationChildren.map((child: Parameters<typeof canonicalizeChildThread>[0]) =>
          canonicalizeChildThread(child),
        )
      : input.orchestrationChildren,
  };
}

// ---------------------------------------------------------------------------
// 1. write → read roundtrip
// ---------------------------------------------------------------------------

test("persistence: writePersistedUiState → readPersistedUiState preserves every reader-supported field", async () => {
  await fc.assert(
    fc.asyncProperty(persistedUiStateArb, async (input) => {
      await withTempDir(async (dir) => {
        const file = join(dir, "ui-state.json");
        await writePersistedUiState(file, input as Parameters<typeof writePersistedUiState>[1]);

        const read = await readPersistedUiState(file);
        const expected = expectedRoundtrip(input as Record<string, unknown>);
        // Compare field by field through a JSON normalization so expected
        // values match the reader's post-JSON.parse objects (prototypes,
        // dropped undefined object keys) exactly.
        for (const field of Object.keys(expected)) {
          assert.deepEqual(
            normalizeJson(expected[field]),
            normalizeJson((read as Record<string, unknown>)[field]),
            `field ${field}`,
          );
        }

        // A freshly written file parses back without corruption.
        const parsed = await readJsonWithBackup<unknown>(file);
        assert.equal(parsed.corrupted, false);
        assert.equal(parsed.recovered, false);
        assert.ok(parsed.value !== undefined);
      });
    }),
    { numRuns: 60 },
  );
});

// ---------------------------------------------------------------------------
// 2. corruption tolerance
// ---------------------------------------------------------------------------

test("persistence: empty pinnedAtBySession normalizes to undefined on read (documented reader behavior)", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "ui-state.json");
    await writePersistedUiState(file, { pinnedAtBySession: {} });
    const read = await readPersistedUiState(file);
    // toStringRecord collapses empty records to undefined; consumers treat
    // missing and empty identically (per-key lookup), so no data is lost.
    assert.equal(read.pinnedAtBySession, undefined);
    assert.equal(read.pinnedSessionOrder, undefined);
  });
});

test("persistence: garbage bytes never throw; read reports corrupted and yields an object", async () => {
  await fc.assert(
    fc.asyncProperty(invalidJsonArb, async (garbage) => {
      await withTempDir(async (dir) => {
        const file = join(dir, "ui-state.json");
        await writeFile(file, garbage, "utf8");

        const restore = silenceConsoleError();
        try {
          const state = await readPersistedUiState(file);
          assert.ok(state && typeof state === "object" && !Array.isArray(state));

          const result = await readJsonWithBackup<unknown>(file);
          assert.equal(result.corrupted, true);
          assert.equal(result.recovered, false);
          assert.equal(result.value, undefined);
        } finally {
          restore();
        }
      });
    }),
    { numRuns: 50 },
  );
});

test("persistence: truncated primary (empty file) is corrupt, never throws", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "ui-state.json");
    await writeFile(file, "", "utf8");
    const restore = silenceConsoleError();
    try {
      const state = await readPersistedUiState(file);
      assert.deepEqual(state, {});
      const result = await readJsonWithBackup<unknown>(file);
      assert.equal(result.corrupted, true);
      assert.equal(result.value, undefined);
    } finally {
      restore();
    }
  });
});

test("persistence: corrupt primary recovers the last good version from .bak (regression spec)", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "ui-state.json");
    const restore = silenceConsoleError();
    try {
      const first = { selectedWorkspaceId: "ws-1", selectedSessionId: "s-1", composerDraft: "draft-one" };
      const second = { ...first, composerDraft: "draft-two" };
      await writePersistedUiState(file, first);
      await writePersistedUiState(file, second); // promotes the first write to .bak

      // Corrupt the primary out-of-band (simulates a crash-truncated file).
      await writeFile(file, "{ definitely not json", "utf8");

      const result = await readJsonWithBackup<Record<string, unknown>>(file);
      assert.equal(result.corrupted, true, "primary corruption is surfaced");
      assert.equal(result.recovered, true, "backup was used");
      assert.deepEqual(result.value, { ...first, version: 15 });

      const state = await readPersistedUiState(file);
      assert.equal(state.composerDraft, "draft-one");
      assert.equal(state.selectedWorkspaceId, "ws-1");
    } finally {
      restore();
    }
  });
});

test("persistence: valid JSON that is not an object shape reads back as an empty/safe state", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "ui-state.json");
    const restore = silenceConsoleError();
    try {
      for (const raw of ['"hello"', "123", "null"]) {
        await writeFile(file, raw, "utf8");
        const state = await readPersistedUiState(file);
        assert.deepEqual(state, {});
      }
      // An array parses to an object at the type level; the reader returns the
      // normalized shell rather than throwing.
      await writeFile(file, "[]", "utf8");
      const state = await readPersistedUiState(file);
      assert.ok(state && typeof state === "object" && !Array.isArray(state));
      assert.equal(state.composerDraft, "");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. JsonFileStore roundtrip
// ---------------------------------------------------------------------------

test("json-file-store: write → read roundtrip preserves arbitrary JSON payloads and keys", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 64 }), fc.jsonValue(), async (key, payload) => {
      await withTempDir(async (dir) => {
        const store = new JsonFileStore<unknown>(dir, "entries");
        await store.write(key, payload);

        const read = await store.read(key);
        assert.deepEqual(read, payload);

        const keys = await store.listKeys();
        assert.ok(keys.includes(key), `listed keys must include ${JSON.stringify(key)}`);

        await store.remove(key);
        assert.equal(await store.read(key), undefined, "removed entry reads back as undefined");
        assert.ok(!(await store.listKeys()).includes(key));
      });
    }),
    { numRuns: 50 },
  );
});

test("json-file-store: missing entries resolve to undefined without throwing", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFileStore<unknown>(dir, "never-created");
    assert.equal(await store.read("anything"), undefined);
    assert.deepEqual(await store.listKeys(), []);
    await store.remove("anything"); // removing a missing entry must not throw
  });
});

test("json-file-store: corrupt entry is reported as undefined without throwing", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFileStore<unknown>(dir, "entries");
    await mkdir(join(dir, "entries"), { recursive: true });
    await writeFile(join(dir, "entries", "bad.json"), "{{{{", "utf8");
    const restore = silenceConsoleError();
    try {
      assert.equal(await store.read("bad"), undefined);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. writeFileAtomicQueued
// ---------------------------------------------------------------------------

test("atomic-file-write: sequential queued writes land fully and in order; .bak holds the previous version", async () => {
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), fc.jsonValue(), async (firstPayload, secondPayload) => {
      await withTempDir(async (dir) => {
        const file = join(dir, "data.json");
        const first = JSON.stringify(firstPayload);
        const second = JSON.stringify(secondPayload);

        await writeFileAtomicQueued(file, first);
        assert.equal(await readFile(file, "utf8"), first, "first write fully observable");

        await writeFileAtomicQueued(file, second);
        assert.equal(await readFile(file, "utf8"), second, "second write fully observable, no partial content");

        const previous = await readFile(`${file}.bak`, "utf8");
        assert.equal(previous, first, ".bak holds the previous good version");

        const result = await readJsonWithBackup<unknown>(file);
        assert.equal(result.corrupted, false);
        // normalizeJson guards against -0/0 divergence across the JSON roundtrip.
        assert.deepEqual(normalizeJson(result.value), normalizeJson(secondPayload));
      });
    }),
    { numRuns: 40 },
  );
});

test("atomic-file-write: concurrent queued writes serialize; last write wins with no corruption", async () => {
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), fc.jsonValue(), async (firstPayload, secondPayload) => {
      await withTempDir(async (dir) => {
        const file = join(dir, "data.json");
        const first = JSON.stringify(firstPayload);
        const second = JSON.stringify(secondPayload);

        const firstWrite = writeFileAtomicQueued(file, first);
        const secondWrite = writeFileAtomicQueued(file, second);
        await Promise.all([firstWrite, secondWrite]);

        assert.deepEqual(normalizeJson(JSON.parse(await readFile(file, "utf8"))), normalizeJson(secondPayload), "final content is the second payload");
        assert.equal(await readFile(`${file}.bak`, "utf8"), first, ".bak holds the first payload");
      });
    }),
    { numRuns: 40 },
  );
});

test("atomic-file-write: first-ever write leaves no .bak (missing file is the expected first-write case)", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "data.json");
    await writeFileAtomicQueued(file, "{}");
    assert.equal(await readFile(file, "utf8"), "{}");
    await assert.rejects(readFile(`${file}.bak`, "utf8"), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
    );
  });
});
