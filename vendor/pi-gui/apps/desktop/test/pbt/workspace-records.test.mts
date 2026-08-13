/**
 * Cardo PBT: workspace-record construction and preview derivation invariants.
 *
 * Locks down:
 *  - buildWorkspaceRecords: one record per workspace, session partitioning +
 *    ordering, worktree classification (foreign linked entry at the workspace's
 *    path ⇒ kind "worktree" with rootWorkspaceId/branchName, else "primary"),
 *    per-session field wiring from the by-session maps.
 *  - previewFromTranscript: deterministic, empty ⇒ undefined, preview drawn
 *    verbatim from transcript content (never fabricated, never from summaries).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { buildWorkspaceRecords, previewFromTranscript } from "../../out-pbt/desktop/electron/app-store-utils.js";
import {
  arbIsoTimestamp,
  arbOptionalString,
  arbSessionRef,
  arbTranscript,
  arbTranscriptCache,
  arbWorkspaceCatalogEntry,
  keyOf,
  deepEqual,
} from "./arbitraries.mts";
import type {
  SessionCatalogEntry,
  WorktreeCatalogEntry,
  WorkspaceCatalogEntry,
} from "../../../../packages/catalogs/dist/index.js";
import type { SessionRef } from "../../../../packages/session-driver/dist/index.js";
import type { TranscriptMessage, WorkspaceRecord } from "../../out-pbt/desktop/src/desktop-state.js";

const NUM_RUNS = 150;

interface RawWorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly kind: "primary" | "worktree";
  readonly rootWorkspaceId?: string;
  readonly branchName?: string;
  readonly sessions: readonly RawSessionRecord[];
}

interface RawSessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly lastViewedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: "idle" | "running" | "failed";
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly config?: unknown;
}

/* ── controlled generator: roots + worktrees + noise ────── */

interface Fixture {
  readonly workspaces: WorkspaceCatalogEntry[];
  readonly worktrees: WorktreeCatalogEntry[];
  readonly sessions: SessionCatalogEntry[];
  readonly transcriptCache: Map<string, TranscriptMessage[]>;
  readonly runningSinceBySession: Map<string, string>;
  readonly sessionConfigBySession: Map<string, unknown>;
  readonly lastViewedAtBySession: Map<string, string>;
  readonly pinnedAtBySession: Map<string, string>;
}

function arbFixture(): fc.Arbitrary<Fixture> {
  // Unique workspace ids; paths are rewritten to be unique per workspace so the
  // worktree classification is deterministic (no reciprocal-pair cases).
  return fc
    .uniqueArray(arbWorkspaceCatalogEntry(), { selector: (w) => w.workspaceId, minLength: 1, maxLength: 4 })
    .map((workspaces) => {
      const seenPaths = new Set<string>();
      const deduped = workspaces.map((w) => {
        let path = w.path;
        while (seenPaths.has(path)) {
          path = `${path}-x`;
        }
        seenPaths.add(path);
        return { ...w, path };
      });
      // For each workspace: always a primary entry at its own path (noise, must
      // not affect classification).
      const worktrees: WorktreeCatalogEntry[] = deduped.map((workspace) => ({
        worktreeId: `${workspace.workspaceId}-primary`,
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        displayName: workspace.displayName,
        kind: "primary",
        status: "ready",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }));
      return { workspaces: deduped, worktrees };
    })
    .chain(({ workspaces, worktrees }) => {
      // Real-app data model: a worktree workspace is owned by a root workspace,
      // and roots are never themselves worktrees (no reciprocal pairs). Generate
      // per-workspace "is worktree" flags, then pick a root from the complement.
      const count = workspaces.length;
      return fc
        .array(fc.boolean(), { minLength: count, maxLength: count })
        .chain((flags) => {
          const worktreeIndices = flags.flatMap((isWorktree, index) => (isWorktree ? [index] : []));
          const rootPool = workspaces.flatMap((w, index) => (flags[index] ? [] : [index]));
          if (worktreeIndices.length === 0 || rootPool.length === 0) {
            return fc.constant({
              worktrees,
              worktreeIndices: [] as number[],
              rootChoices: [] as number[],
              rootPool: [] as number[],
            });
          }
          return fc
            .array(fc.integer({ min: 0, max: rootPool.length - 1 }), {
              minLength: worktreeIndices.length,
              maxLength: worktreeIndices.length,
            })
            .map((rootChoices) => ({ worktrees, worktreeIndices, rootChoices, rootPool }));
        })
        .map(({ worktrees, worktreeIndices, rootChoices, rootPool }) => {
          const entries = [...worktrees];
          worktreeIndices.forEach((workspaceIndex, linkIndex) => {
            const workspace = workspaces[workspaceIndex];
            const root = workspaces[rootPool[rootChoices[linkIndex] ?? 0]];
            if (!workspace || !root || workspace.workspaceId === root.workspaceId) {
              return;
            }
            entries.push({
              worktreeId: `${workspace.workspaceId}-linked-${entries.length}`,
              workspaceId: root.workspaceId,
              path: workspace.path,
              displayName: workspace.displayName,
              kind: "linked",
              status: "ready",
              branchName: `branch-${linkIndex}`,
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
            });
          });
          return { workspaces, worktrees: entries };
        });
    })
    .chain(({ workspaces, worktrees }) => {
      // Sessions partition across workspaces; maps keyed by session key.
      const sessionsArb = fc.array(
        fc.record({
          workspaceIndex: fc.integer({ min: 0, max: Math.max(0, workspaces.length - 1) }),
          sessionId: fc.uuid(),
          title: fc.string({ minLength: 0, maxLength: 40 }),
          updatedAt: arbIsoTimestamp(),
          archivedAt: arbOptionalString(),
          previewSnippet: arbOptionalString(),
          status: fc.constantFrom("idle", "running", "failed"),
        }),
        { maxLength: 6 },
      );
      return fc
        .tuple(
          sessionsArb,
          arbTranscriptCache(),
          fc.array(fc.tuple(fc.string(), fc.string())),
          fc.array(fc.tuple(fc.string(), fc.string())),
          fc.array(fc.tuple(fc.string(), fc.string())),
        )
        .map(([sessionInputs, transcriptCache, runningPairs, lastViewedPairs, pinnedPairs]) => {
          const sessions: SessionCatalogEntry[] = sessionInputs.map((input) => {
            const workspace = workspaces[input.workspaceIndex];
            return {
              sessionRef: { workspaceId: workspace.workspaceId, sessionId: input.sessionId },
              workspaceId: workspace.workspaceId,
              title: input.title,
              updatedAt: input.updatedAt,
              archivedAt: input.archivedAt,
              previewSnippet: input.previewSnippet,
              status: input.status,
            };
          });
          return {
            workspaces,
            worktrees,
            sessions,
            transcriptCache,
            runningSinceBySession: new Map(runningPairs),
            sessionConfigBySession: new Map<string, unknown>(),
            lastViewedAtBySession: new Map(lastViewedPairs),
            pinnedAtBySession: new Map(pinnedPairs),
          } satisfies Fixture;
        });
    });
}

/* ── buildWorkspaceRecords ──────────────────────────────── */

test("buildWorkspaceRecords: one output record per input workspace, in order", () => {
  fc.assert(
    fc.property(arbFixture(), (fixture) => {
      const records = buildWorkspaceRecords(
        fixture.workspaces,
        fixture.worktrees,
        fixture.sessions,
        fixture.transcriptCache,
        fixture.runningSinceBySession,
        fixture.sessionConfigBySession,
        fixture.lastViewedAtBySession,
        fixture.pinnedAtBySession,
      ) as unknown as RawWorkspaceRecord[];

      assert.equal(records.length, fixture.workspaces.length);
      records.forEach((record, index) => {
        const workspace = fixture.workspaces[index];
        assert.equal(record.id, workspace.workspaceId);
        assert.equal(record.name, workspace.displayName);
        assert.equal(record.path, workspace.path);
        assert.equal(record.lastOpenedAt, workspace.lastOpenedAt);
      });
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildWorkspaceRecords: sessions are partitioned by workspaceId, ordered as in the input", () => {
  fc.assert(
    fc.property(arbFixture(), (fixture) => {
      const records = buildWorkspaceRecords(
        fixture.workspaces,
        fixture.worktrees,
        fixture.sessions,
        fixture.transcriptCache,
        fixture.runningSinceBySession,
        fixture.sessionConfigBySession,
        fixture.lastViewedAtBySession,
        fixture.pinnedAtBySession,
      ) as unknown as RawWorkspaceRecord[];

      const expectedIds = new Map(fixture.workspaces.map((w) => [w.workspaceId, [] as string[]]));
      for (const session of fixture.sessions) {
        expectedIds.get(session.workspaceId)?.push(session.sessionRef.sessionId);
      }

      for (const record of records) {
        const expected = expectedIds.get(record.id) ?? [];
        assert.deepEqual(
          record.sessions.map((s) => s.id),
          expected,
          `sessions of workspace ${record.id} must match input order`,
        );
        // Every session in the record belongs to the record's workspace.
        record.sessions.forEach((session) => {
          const catalog = fixture.sessions.find((s) => s.sessionRef.sessionId === session.id);
          assert.ok(catalog, "session must come from the catalog");
          assert.equal(catalog.workspaceId, record.id);
        });
      }

      // Every catalog session appears exactly once across all records.
      const seen = records.flatMap((r) => r.sessions.map((s) => s.id));
      fixture.sessions.forEach((session) => {
        assert.equal(
          seen.filter((id) => id === session.sessionRef.sessionId).length,
          1,
          `session ${session.sessionRef.sessionId} must appear exactly once`,
        );
      });
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildWorkspaceRecords: worktree classification — foreign linked entry at the path ⇒ worktree, else primary", () => {
  fc.assert(
    fc.property(arbFixture(), (fixture) => {
      const records = buildWorkspaceRecords(
        fixture.workspaces,
        fixture.worktrees,
        fixture.sessions,
        fixture.transcriptCache,
        fixture.runningSinceBySession,
        fixture.sessionConfigBySession,
        fixture.lastViewedAtBySession,
        fixture.pinnedAtBySession,
      ) as unknown as RawWorkspaceRecord[];

      for (const workspace of fixture.workspaces) {
        const record = records.find((r) => r.id === workspace.workspaceId)!;
        // A workspace is a worktree when a LINKED worktree entry at its path is
        // owned by a different workspace (the root).
        const foreign = fixture.worktrees.filter(
          (t) => t.kind === "linked" && t.path === workspace.path && t.workspaceId !== workspace.workspaceId,
        );

        if (foreign.length > 0) {
          assert.equal(record.kind, "worktree");
          assert.equal(record.rootWorkspaceId, foreign[0].workspaceId);
          assert.equal(
            record.branchName,
            fixture.worktrees.find(
              (t) => t.kind === "linked" && t.path === workspace.path && t.workspaceId === record.rootWorkspaceId,
            )?.branchName,
          );
        } else {
          assert.equal(record.kind, "primary");
          assert.equal(record.rootWorkspaceId, undefined);
          assert.equal(record.branchName, undefined);
        }
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

test("buildWorkspaceRecords: session records wire through the by-session maps and catalog fields", () => {
  fc.assert(
    fc.property(arbFixture(), (fixture) => {
      const records = buildWorkspaceRecords(
        fixture.workspaces,
        fixture.worktrees,
        fixture.sessions,
        fixture.transcriptCache,
        fixture.runningSinceBySession,
        fixture.sessionConfigBySession,
        fixture.lastViewedAtBySession,
        fixture.pinnedAtBySession,
      ) as unknown as RawWorkspaceRecord[];

      for (const record of records) {
        for (const session of record.sessions) {
          const catalog = fixture.sessions.find((s) => s.sessionRef.sessionId === session.id)!;
          const key = keyOf(catalog.sessionRef);
          assert.equal(session.title, catalog.title);
          assert.equal(session.updatedAt, catalog.updatedAt);
          assert.equal(session.status, catalog.status);
          assert.equal(session.archivedAt, catalog.archivedAt);
          assert.equal(session.runningSince, fixture.runningSinceBySession.get(key));
          assert.equal(session.lastViewedAt, fixture.lastViewedAtBySession.get(key));
          assert.equal(session.pinnedAt, fixture.pinnedAtBySession.get(key));
          assert.equal(session.config, fixture.sessionConfigBySession.get(key));

          const transcript = fixture.transcriptCache.get(key) ?? [];
          const expectedPreview = previewFromTranscript(transcript) ?? catalog.previewSnippet ?? catalog.title;
          assert.equal(session.preview, expectedPreview);
        }
      }
    }),
    { numRuns: NUM_RUNS },
  );
});

/* ── previewFromTranscript ──────────────────────────────── */

test("previewFromTranscript: deterministic for the same transcript", () => {
  fc.assert(
    fc.property(arbTranscript(), (transcript) => {
      assert.equal(previewFromTranscript(transcript), previewFromTranscript(transcript));
    }),
    { numRuns: NUM_RUNS },
  );
});

test("previewFromTranscript: empty transcript yields undefined", () => {
  assert.equal(previewFromTranscript([]), undefined);
});

test("previewFromTranscript: preview is drawn verbatim from transcript content (never fabricated)", () => {
  fc.assert(
    fc.property(arbTranscript(), (transcript) => {
      const preview = previewFromTranscript(transcript);
      if (preview === undefined) {
        return;
      }
      const candidates = new Set<string>();
      for (const item of transcript) {
        if (item.kind === "message") {
          candidates.add(item.text);
        } else if (item.kind === "tool" || item.kind === "activity") {
          candidates.add(item.label);
        }
        // summary items are deliberately not preview sources
      }
      assert.ok(
        candidates.has(preview),
        `preview ${JSON.stringify(preview)} must be one of the transcript texts/labels`,
      );
    }),
    { numRuns: NUM_RUNS },
  );
});

test("previewFromTranscript: preview never exceeds the longest source text/label", () => {
  fc.assert(
    fc.property(arbTranscript(), (transcript) => {
      const preview = previewFromTranscript(transcript);
      if (preview === undefined) {
        return;
      }
      const maxSource = Math.max(
        0,
        ...transcript.map((item) => {
          if (item.kind === "message") {
            return item.text.length;
          }
          if (item.kind === "tool" || item.kind === "activity") {
            return item.label.length;
          }
          return 0;
        }),
      );
      assert.ok(preview.length <= maxSource, "preview length must be bounded by its source content");
    }),
    { numRuns: NUM_RUNS },
  );
});
