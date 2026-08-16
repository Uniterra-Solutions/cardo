/**
 * Cardo integrated PBT: the state snapshot + delta delivery contract.
 *
 * Pipeline under test (mirrors electron/main.ts publishStateToWindow + the
 * renderer's future useDesktopAppState apply, using the compiled pure modules):
 *
 *   store state (DesktopAppState, identity-preserving slice updates — T1) →
 *     stateSlicesWithoutOrchestration (projection, orchestration stripped) →
 *     publish decision (decideStateDelivery against the last published
 *       snapshot) → full (pi-gui:state-changed) OR delta ops
 *       (pi-gui:state-delta) →
 *     renderer side: applyStateDelta onto its local state
 *
 * Invariants locked here (see .plan/16-08-2026/real-time-streaming/tasks.md
 * T2 section + acceptance.md §1/§6):
 *
 *  CONV. Convergence / byte-compat — no matter how store pushes are batched
 *     (coalescing is arbitrary at the renderer), applying the delivered ops to
 *     the renderer's local state always reproduces the store state exactly:
 *     JSON.stringify(applyStateDelta(prev, computeStateDelta(prev, next))) ===
 *     JSON.stringify(next). The renderer's final content is byte-identical to
 *     the full-snapshot result.
 *  ID.   Identity — slices not in the ops keep === identity across
 *     applyStateDelta (memo short-circuit), and equal the store's current
 *     slice references.
 *  DEC.  Delivery decision — last undefined / session switch → full;
 *     content-unchanged → delta with zero ops; same-session change → delta
 *     with ops.length ≤ changed-slice count (reference-accelerated liveness:
 *     a deep-cloning projection would re-emit every slice per push and break
 *     this bound).
 *  ORCH. Exclusion — computeStateDelta never emits an orchestrationChildren
 *     op; stateSlicesWithoutOrchestration drops the key entirely
 *     ("orchestrationChildren" in slices is false).
 *  REV.  Revision — applying a delta sets revision to the payload revision;
 *     ops with value === undefined DELETE the key (absent, not undefined).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { createEmptyDesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import type { DesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import {
  applyStateDelta,
  computeStateDelta,
  decideStateDelivery,
  stateSlicesWithoutOrchestration,
  type PublishedStateSnapshot,
  type StateSlices,
} from "../../out-pbt/desktop/src/state-delta.js";

/* ── arbitraries: identity-preserving slice mutations ──── */

/** Sentinel: the mutation pass leaves this slice untouched (identity kept). */
const SKIP = Symbol("state-delta-skip");

const workspaceRecordArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  name: fc.string({ maxLength: 20 }),
  path: fc.string({ minLength: 1, maxLength: 30 }),
  lastOpenedAt: fc.string({ minLength: 1, maxLength: 30 }),
  kind: fc.constantFrom("primary" as const, "worktree"),
  sessions: fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 12 }),
      title: fc.string({ maxLength: 20 }),
      updatedAt: fc.string({ minLength: 1, maxLength: 30 }),
      preview: fc.string({ maxLength: 40 }),
      status: fc.constantFrom("idle" as const, "running", "failed"),
      hasUnseenUpdate: fc.boolean(),
    }),
    { maxLength: 3 },
  ),
});

const childThreadArb = fc.record({
  id: fc.uuid(),
  parentWorkspaceId: fc.string({ minLength: 1, maxLength: 12 }),
  parentSessionId: fc.string({ minLength: 1, maxLength: 12 }),
  childWorkspaceId: fc.string({ minLength: 1, maxLength: 12 }),
  childSessionId: fc.string({ minLength: 1, maxLength: 12 }),
  title: fc.string({ maxLength: 20 }),
  goal: fc.string({ maxLength: 20 }),
  status: fc.constantFrom("queued" as const, "running", "waiting", "complete", "failed"),
  latestTranscript: fc.string({ maxLength: 30 }),
  transcript: fc.array(
    fc.record({
      id: fc.uuid(),
      role: fc.constantFrom("parent" as const, "child", "system"),
      text: fc.string({ maxLength: 30 }),
      createdAt: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    { maxLength: 3 },
  ),
  evidence: fc.array(
    fc.record({
      id: fc.uuid(),
      childThreadId: fc.uuid(),
      kind: fc.constantFrom("worker_report" as const, "command", "review_finding"),
      source: fc.constantFrom("worker-reported" as const, "command", "review"),
      status: fc.constantFrom("reported" as const, "accepted", "passed"),
      title: fc.string({ maxLength: 20 }),
      createdAt: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    { maxLength: 2 },
  ),
  createdAt: fc.string({ minLength: 1, maxLength: 30 }),
  updatedAt: fc.string({ minLength: 1, maxLength: 30 }),
});

/** Arbitrary values for a representative spread of slice types. */
const sliceValueArbs = {
  workspaces: fc.array(workspaceRecordArb, { maxLength: 3 }),
  selectedWorkspaceId: fc.string({ minLength: 1, maxLength: 12 }),
  selectedSessionId: fc.string({ minLength: 1, maxLength: 12 }),
  activeView: fc.constantFrom("threads" as const, "new-thread", "skills", "extensions", "settings"),
  composerDraft: fc.string({ maxLength: 40 }),
  composerDraftSyncNonce: fc.integer({ min: 0, max: 100_000 }),
  composerAttachments: fc.array(
    fc.record({ id: fc.uuid(), name: fc.string({ maxLength: 20 }), path: fc.string({ maxLength: 30 }) }),
    { maxLength: 3 },
  ),
  queuedComposerMessages: fc.array(
    fc.record({
      id: fc.uuid(),
      mode: fc.constant("followUp" as const),
      text: fc.string({ maxLength: 30 }),
      createdAt: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    { maxLength: 2 },
  ),
  sidebarCollapsed: fc.boolean(),
  enableTransparency: fc.boolean(),
  lastViewedAtBySession: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 20 })),
  pinnedSessionOrder: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  workspaceOrder: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  revision: fc.integer({ min: 0, max: 100_000 }),
  lastError: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
};

/** Per-slice mutation arbitraries (fresh values; SKIP keeps the slice untouched). */
const mutationValueArbs: Record<string, fc.Arbitrary<unknown>> = {
  workspaces: fc.array(workspaceRecordArb, { maxLength: 3 }),
  selectedWorkspaceId: fc.string({ minLength: 1, maxLength: 12 }),
  selectedSessionId: fc.string({ minLength: 1, maxLength: 12 }),
  composerDraft: fc.string({ maxLength: 40 }),
  composerDraftSyncNonce: fc.integer({ min: 0, max: 100_000 }),
  sidebarCollapsed: fc.boolean(),
  lastViewedAtBySession: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 20 })),
  revision: fc.integer({ min: 0, max: 100_000 }),
  // value undefined ⇒ the slice is cleared (op with value undefined ⇒ delete).
  lastError: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 30 })),
};

const mutationArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  Object.fromEntries(
    Object.entries(mutationValueArbs).map(([key, arb]) => [key, fc.oneof(fc.constant(SKIP), arb)]),
  ),
);

/** Identity-preserving overlay — mirrors how the store spreads unchanged slices. */
function applyMutations(previous: DesktopAppState, mutations: Record<string, unknown>): DesktopAppState {
  let next: DesktopAppState = previous;
  for (const [key, value] of Object.entries(mutations)) {
    if (value === SKIP) {
      continue;
    }
    next = { ...next, [key]: value } as DesktopAppState;
  }
  return next;
}

function buildState(sliceValues: Record<string, unknown>): DesktopAppState {
  // Drop the base's orchestrationChildren first so the overlay re-appends it at
  // the END — the same key position the renderer's merge (T3) produces, keeping
  // JSON.stringify comparison order-consistent across the full/delta paths.
  const { orchestrationChildren: _baseOrchestration, ...baseSlices } = createEmptyDesktopAppState();
  return {
    ...baseSlices,
    ...sliceValues,
    orchestrationChildren: [],
  } as DesktopAppState;
}

/**
 * Reference-based count of slices that differ between two projections —
 * exactly the set `computeStateDelta` emits ops for (reference-accelerated:
 * ops are emitted precisely when previous[key] !== current[key]).
 */
function referenceChangedSliceCount(previous: StateSlices, current: StateSlices): number {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  let changed = 0;
  for (const key of keys) {
    if ((previous as Record<string, unknown>)[key] !== (current as Record<string, unknown>)[key]) {
      changed += 1;
    }
  }
  return changed;
}

/* ── CONV: byte-compatible convergence (pure module) ────── */

test("CONV: apply(prev, compute(prev, next)) is byte-equal to next", async () => {
  await fc.assert(
    fc.asyncProperty(fc.record(sliceValueArbs), mutationArb, async (sliceValues, mutations) => {
      const previous = buildState(sliceValues);
      const next = applyMutations(previous, mutations);
      const ops = computeStateDelta(
        stateSlicesWithoutOrchestration(previous),
        stateSlicesWithoutOrchestration(next),
      );
      const applied = applyStateDelta(previous, ops);
      assert.equal(
        JSON.stringify(applied),
        JSON.stringify(next),
        "renderer final content must be byte-identical to the full-snapshot result",
      );
    }),
    { numRuns: 100 },
  );
});

/* ── CONV pipeline: convergence through arbitrary publish batching ── */

test("CONV pipeline: renderer stays byte-equal to the store under full + delta publishes", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record(sliceValueArbs),
      fc.array(mutationArb, { maxLength: 40 }),
      fc.array(fc.boolean(), { maxLength: 40 }),
      async (initialSlices, mutationPasses, publishMask) => {
        let storeState = buildState(initialSlices);
        let lastPublished: PublishedStateSnapshot | undefined = undefined;
        let rendererState: DesktopAppState | null = null;

        const publish = (current: DesktopAppState) => {
          const slices = stateSlicesWithoutOrchestration(current);
          const delivery = decideStateDelivery(lastPublished, slices);
          if (delivery.kind === "full") {
            // Full path: the renderer replaces its local state (orchestration
            // merged from its own channel — never rides the state payload).
            rendererState = { ...slices, orchestrationChildren: [] } as DesktopAppState;
            lastPublished = { revision: current.revision, slices };
          } else if (delivery.ops.length > 0) {
            // Delta path: apply ops locally; empty deltas are skipped (no send).
            rendererState = applyStateDelta(
              rendererState ?? ({ ...slices, orchestrationChildren: [] } as DesktopAppState),
              delivery.ops,
            );
            lastPublished = { revision: current.revision, slices };
          }
        };

        publish(storeState);
        assert.ok(rendererState !== null, "first publish must deliver a full state");
        assert.equal(JSON.stringify(rendererState), JSON.stringify(storeState));

        for (let index = 0; index < mutationPasses.length; index += 1) {
          storeState = applyMutations(storeState, mutationPasses[index]!);
          if (publishMask[index] ?? false) {
            publish(storeState);
            assert.equal(
              JSON.stringify(rendererState),
              JSON.stringify(storeState),
              "renderer must stay byte-equal to the store after every publish",
            );
          }
        }
        publish(storeState);
        assert.equal(JSON.stringify(rendererState), JSON.stringify(storeState), "final publish must converge");
      },
    ),
    { numRuns: 60 },
  );
});

/* ── ID: identity of untouched slices ───────────────────── */

test("ID: applyStateDelta keeps untouched slice identity (memo short-circuit)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.record(sliceValueArbs), mutationArb, async (sliceValues, mutations) => {
      const previous = buildState(sliceValues);
      const next = applyMutations(previous, mutations);
      const ops = computeStateDelta(
        stateSlicesWithoutOrchestration(previous),
        stateSlicesWithoutOrchestration(next),
      );
      const applied = applyStateDelta(previous, ops);
      const opKeys = new Set<string>(ops.map((op) => op.key));
      const appliedSlices = stateSlicesWithoutOrchestration(applied) as Record<string, unknown>;
      const previousSlices = stateSlicesWithoutOrchestration(previous) as Record<string, unknown>;
      const nextSlices = stateSlicesWithoutOrchestration(next) as Record<string, unknown>;
      for (const key of Object.keys(nextSlices)) {
        if (opKeys.has(key)) {
          continue;
        }
        assert.equal(appliedSlices[key], previousSlices[key], `untouched slice ${key} must keep object identity`);
        assert.equal(appliedSlices[key], nextSlices[key], `untouched slice ${key} must equal the store's current slice`);
      }
    }),
    { numRuns: 100 },
  );
});

/* ── DEC: delivery decisions ────────────────────────────── */

test("DEC: first publish and session switch are full; unchanged content publishes nothing", async () => {
  await fc.assert(
    fc.asyncProperty(fc.record(sliceValueArbs), mutationArb, async (sliceValues, mutations) => {
      const previous = buildState(sliceValues);
      const previousSlices = stateSlicesWithoutOrchestration(previous);

      // Never published → always full (also covers renderer recovery).
      assert.equal(decideStateDelivery(undefined, previousSlices).kind, "full");
      assert.equal(decideStateDelivery(undefined, null).kind, "full");

      const last: PublishedStateSnapshot = { revision: previous.revision, slices: previousSlices };

      // Content-unchanged (same slices) → delta with zero ops (skip send).
      const unchanged = decideStateDelivery(last, previousSlices);
      assert.equal(unchanged.kind, "delta");
      assert.equal(unchanged.ops.length, 0, "unchanged content must publish zero ops");

      // Re-projecting the SAME store content must keep slice identity
      // (identity-preserving spread — T1's clone-free projection). If the
      // projection deep-cloned (structuredClone), every slice reference would
      // change and this re-publish would emit ops for ALL slices instead of
      // zero — the lock on T1's clone removal.
      const reProjected = stateSlicesWithoutOrchestration({ ...previous });
      const rePublished = decideStateDelivery(last, reProjected);
      assert.equal(rePublished.kind, "delta");
      assert.equal(
        rePublished.ops.length,
        0,
        "content-unchanged re-projection must publish zero ops (identity-preserving projection)",
      );

      // Session switch (either dimension) → full, never a delta.
      const switchedWorkspace = decideStateDelivery(last, { ...previousSlices, selectedWorkspaceId: "other-ws" });
      assert.equal(switchedWorkspace.kind, "full", "workspace switch must ship a full snapshot");
      const switchedSession = decideStateDelivery(last, { ...previousSlices, selectedSessionId: "other-session" });
      assert.equal(switchedSession.kind, "full", "session switch must ship a full snapshot");

      // Same-session change → delta with ops ≤ content-changed slice count
      // (liveness: a deep-cloning projection would re-emit every slice and
      // break this bound — the lock on T1's structuredClone removal).
      const next = applyMutations(previous, mutations);
      const nextSlices = stateSlicesWithoutOrchestration(next);
      if (
        nextSlices.selectedWorkspaceId === previousSlices.selectedWorkspaceId &&
        nextSlices.selectedSessionId === previousSlices.selectedSessionId
      ) {
        const delivery = decideStateDelivery(last, nextSlices);
        assert.equal(delivery.kind, "delta", "same-session change must be a delta, never a full");
        const changed = referenceChangedSliceCount(previousSlices, nextSlices);
        assert.ok(
          delivery.ops.length <= changed,
          `delta ops (${delivery.ops.length}) must never exceed reference-changed slices (${changed})`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ── ORCH: orchestration exclusion ──────────────────────── */

test("ORCH: orchestrationChildren never rides the delta and is dropped from slices", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record(sliceValueArbs),
      fc.array(childThreadArb, { maxLength: 3 }),
      fc.array(childThreadArb, { maxLength: 3 }),
      async (sliceValues, orchestrationPrevious, orchestrationNext) => {
        const previous = {
          ...buildState(sliceValues),
          orchestrationChildren: orchestrationPrevious,
        } as DesktopAppState;
        const next = {
          ...previous,
          orchestrationChildren: orchestrationNext,
          revision: (sliceValues.revision as number) + 1,
        } as DesktopAppState;

        const ops = computeStateDelta(
          stateSlicesWithoutOrchestration(previous),
          stateSlicesWithoutOrchestration(next),
        );
        for (const op of ops) {
          assert.notEqual(
            op.key,
            "orchestrationChildren",
            "computeStateDelta must never emit an orchestrationChildren op",
          );
        }

        const slices = stateSlicesWithoutOrchestration(next);
        assert.ok(
          !("orchestrationChildren" in slices),
          "stateSlicesWithoutOrchestration must drop the key entirely (absent, not undefined)",
        );
      },
    ),
    { numRuns: 50 },
  );
});

/* ── REV: revision advance + delete semantics ───────────── */

test("REV: applying a delta sets revision to the payload revision; undefined values delete keys", () => {
  const previous = {
    ...buildState({ revision: 7 }),
    lastError: "boom",
  } as DesktopAppState;

  // The main process ships ops that include the revision slice (it changes on
  // every push) and payload.revision === the new store revision; the renderer
  // applies the ops and lands on exactly that revision.
  const applied = applyStateDelta(previous, [
    { kind: "set", key: "revision", value: 42 },
    { kind: "set", key: "lastError", value: undefined },
  ]);

  assert.equal(applied.revision, 42, "applying a delta must advance revision to the payload revision");
  assert.ok(!("lastError" in applied), "an op with value undefined must DELETE the key (absent, not undefined)");
  assert.equal((applied as { lastError?: string }).lastError, undefined);

  // Untouched slices keep identity.
  assert.equal(applied.workspaces, previous.workspaces);
  assert.equal(applied.sidebarCollapsed, previous.sidebarCollapsed);

  // Same-value set is a no-op that keeps identity.
  const noop = applyStateDelta(previous, [{ kind: "set", key: "sidebarCollapsed", value: previous.sidebarCollapsed }]);
  assert.equal(noop.sidebarCollapsed, previous.sidebarCollapsed);
});
