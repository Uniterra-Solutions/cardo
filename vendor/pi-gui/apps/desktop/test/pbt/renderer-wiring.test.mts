/**
 * Cardo integrated PBT: the RENDERER's multi-channel apply wiring under a long
 * task.
 *
 * The per-channel suites (transcript-delta.test.mts, state-delta.test.mts)
 * lock each delivery contract in isolation. This suite locks the wiring that
 * desktop-app-state.ts performs on EVERY push during a long agent run — the
 * exact interleaving of the five channels the main process sends:
 *
 *   state-changed      (full, orchestration-stripped — session switch /
 *                       first publish / renderer recovery)
 *   state-delta        (changed slices only, carries revision)
 *   orchestration-changed (child-thread transcripts + evidence, ref-changed)
 *   selected-transcript-changed (full transcript on switch / first publish)
 *   transcript-delta   (changed items only)
 *
 * plus the IPC response paths (getState / getSelectedTranscript) that race
 * the pushed channels. The renderer apply order and revision guards are
 * replicated here EXACTLY as in src/app/desktop-app-state.ts (that hook is
 * not PBT-compiled, so the harness pins its semantics against the real pure
 * modules): full-vs-delta revision guards (< for fulls, <= for deltas),
 * seed-before-apply drop (a slices-only push is dropped until a full
 * DesktopAppState seeds the orchestration ref), orchestration ref merge,
 * transcript session-match guard, and the receivedPushedTranscript latch.
 *
 * Invariants locked here (the long-task white-screen hunt, 2026-08-16):
 *
 *  W-CONV  Convergence — under ANY coalescing batching, ANY channel
 *          interleaving, and a seed response racing the first pushes, the
 *          renderer's local state (slices + orchestration) and local
 *          transcript converge to the store's after every publish window.
 *          Byte-compatible content, item-for-item order.
 *  W-REV   Revision monotonicity — the renderer's revision never decreases,
 *          and equals the store's at convergence.
 *  W-ID    Identity — slices and transcript items not touched by the last
 *          delta keep their object identity (memo short-circuit contract).
 *  W-TOT   Totality — processing any in-domain delivery sequence never
 *          throws (a renderer exception mid-task is the white-screen class).
 *  W-REL   Reload recovery — a renderer (re)mount forces the next state +
 *          transcript deliveries to be FULL (main clears last-published on
 *          re-subscribe), and the fresh renderer converges from those.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  appendAssistantDelta,
  appendThinkingDelta,
  applyTimelineEvent,
  finalizeActiveThinking,
  type TranscriptCacheEntry,
} from "../../out-pbt/desktop/electron/app-store-timeline.js";
import { applySessionEventState } from "../../out-pbt/desktop/electron/app-store-session-state.js";
import { createEmptyDesktopAppState } from "../../out-pbt/desktop/src/desktop-state.js";
import type {
  DesktopAppState,
  OrchestrationChildThread,
  SelectedTranscriptRecord,
  TranscriptMessage,
} from "../../out-pbt/desktop/src/desktop-state.js";
import {
  applyStateDelta,
  decideStateDelivery,
  stateSlicesWithoutOrchestration,
  type PublishedStateSnapshot,
  type StateDeltaPayload,
  type StateSlices,
} from "../../out-pbt/desktop/src/state-delta.js";
import {
  applyTranscriptDelta,
  decideTranscriptDelivery,
  type PublishedTranscriptSnapshot,
  type TranscriptDeltaPayload,
} from "../../out-pbt/desktop/src/transcript-delta.js";

/* ── fixed sessions ────────────────────────────────────── */

const WS_ID = "wiring-ws";
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const REF_A: SessionRef = { workspaceId: WS_ID, sessionId: SESSION_A };
const KEY_A = sessionKey(REF_A);

/* ── caches + the real flow driver (mirrors app-store) ──── */

interface FlowCaches {
  transcriptCache: Map<string, TranscriptCacheEntry>;
  runningSinceBySession: Map<string, string>;
  lastViewedAtBySession: Map<string, string>;
  activeAssistantMessageBySession: Map<string, string>;
  activeWorkingActivityBySession: Map<string, string>;
  activeThinkingBySession: Map<string, { id: string; text: string; startedAt: string }>;
  runMetricsBySession: Map<string, { startedAt: string; toolCount: number; searchCount: number; fileCount: number }>;
}

function freshCaches(): FlowCaches {
  return {
    transcriptCache: new Map(),
    runningSinceBySession: new Map(),
    lastViewedAtBySession: new Map(),
    activeAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    activeThinkingBySession: new Map(),
    runMetricsBySession: new Map(),
  };
}

/** Mirrors electron/app-store.ts handleSessionEvent ordering for delta events. */
function driveEvent(caches: FlowCaches, event: SessionDriverEvent): void {
  if (event.type === "assistantDelta") {
    finalizeActiveThinking(caches.transcriptCache, caches.activeThinkingBySession, event.sessionRef);
    appendAssistantDelta(caches.transcriptCache, caches.activeAssistantMessageBySession, event.sessionRef, event.text);
  } else if (event.type === "assistantThinkingDelta") {
    appendThinkingDelta(caches.transcriptCache, caches.activeThinkingBySession, event.sessionRef, event.text);
  }
  applyTimelineEvent(caches.transcriptCache, event, {
    runMetricsBySession: caches.runMetricsBySession,
    runningSinceBySession: caches.runningSinceBySession,
    activeAssistantMessageBySession: caches.activeAssistantMessageBySession,
    activeWorkingActivityBySession: caches.activeWorkingActivityBySession,
    activeThinkingBySession: caches.activeThinkingBySession,
  });
}

function makeInitialState(): DesktopAppState {
  const session = (id: string) => ({
    id,
    title: `${id} title`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    preview: "",
    status: "idle" as const,
    hasUnseenUpdate: false,
  });
  return {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: WS_ID,
    selectedSessionId: SESSION_A,
    workspaces: [
      {
        id: WS_ID,
        name: "wiring workspace",
        path: "/tmp/wiring-ws",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        kind: "primary",
        sessions: [session(SESSION_A), session(SESSION_B)],
      },
    ],
  };
}

function transcriptOf(caches: FlowCaches, key: string): readonly TranscriptMessage[] {
  const entry = caches.transcriptCache.get(key);
  return entry === undefined ? [] : entry.toArray();
}

/* ── coherent event generator (fixed, parseable timestamps) ── */

const tsArb = fc
  .integer({ min: Date.parse("2026-01-01T00:00:00.000Z"), max: Date.parse("2026-12-31T23:59:59.999Z") })
  .map((ms) => new Date(ms).toISOString());

const snapshotArb = fc.record({
  ref: fc.constant(REF_A),
  workspace: fc.constant({ workspaceId: WS_ID, path: "/tmp/wiring-ws" }),
  title: fc.string({ minLength: 1, maxLength: 40 }),
  status: fc.constantFrom("idle" as const, "running" as const, "failed" as const),
  updatedAt: tsArb,
  archivedAt: fc.option(tsArb, { nil: undefined }),
  preview: fc.option(fc.string(), { nil: undefined }),
  config: fc.constant(undefined),
  runningRunId: fc.option(fc.uuid(), { nil: undefined }),
  queuedMessages: fc.constant([] as never[]),
});

const deltaEventArb: fc.Arbitrary<SessionDriverEvent> = fc.oneof(
  fc.record({
    type: fc.constant("assistantDelta" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    text: fc.string({ maxLength: 60 }),
  }),
  fc.record({
    type: fc.constant("assistantThinkingDelta" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    text: fc.string({ maxLength: 60 }),
  }),
  fc.record({
    type: fc.constant("sessionUpdated" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    snapshot: snapshotArb,
  }),
  fc.record({
    type: fc.constant("queuedMessageStarted" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    message: fc.record({
      id: fc.uuid(),
      mode: fc.constant("followUp" as const),
      text: fc.string({ maxLength: 60 }),
      attachments: fc.constant([] as never[]),
      createdAt: tsArb,
      updatedAt: tsArb,
    }),
  }),
  fc.record({
    type: fc.constant("toolStarted" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    toolName: fc.string({ minLength: 1, maxLength: 40 }),
    callId: fc.uuid(),
    input: fc.option(fc.jsonValue(), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant("toolUpdated" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    callId: fc.uuid(),
    text: fc.option(fc.string(), { nil: undefined }),
    progress: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant("toolFinished" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    callId: fc.uuid(),
    success: fc.boolean(),
    output: fc.option(fc.jsonValue(), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant("runFailed" as const),
    sessionRef: fc.constant(REF_A),
    timestamp: tsArb,
    error: fc.record({
      message: fc.string({ minLength: 1, maxLength: 60 }),
      code: fc.option(fc.string(), { nil: undefined }),
    }),
  }),
);

/* ── the renderer (replicates desktop-app-state.ts wiring) ── */

type Delivery =
  | { kind: "state-changed"; slices: StateSlices }
  | { kind: "state-delta"; payload: StateDeltaPayload }
  | { kind: "orchestration-changed"; orchestrationChildren: readonly OrchestrationChildThread[] }
  | { kind: "transcript-changed"; record: SelectedTranscriptRecord }
  | { kind: "transcript-delta"; payload: TranscriptDeltaPayload };

class RendererSim {
  snapshot: DesktopAppState | null = null;
  orchestrationRef: readonly OrchestrationChildThread[] | null = null;
  selectedTranscript: SelectedTranscriptRecord | null = null;
  receivedPushedTranscript = false;
  // Cardo: latest pushed full buffered while no full DesktopAppState has
  // arrived (fixed drop-then-stale-seed hole — W-CONV).
  pendingFull: StateSlices | null = null;
  // Cardo: pre-seed state-deltas buffered in order; replayed by the seed drain.
  pendingDeltas: StateDeltaPayload[] = [];
  // Cardo: true once a full DesktopAppState flowed through (seed / IPC
  // response). The buffer decision keys off THIS — orchestration-changed can
  // arrive pre-seed and set the ref to a non-null value.
  hasFullState = false;

  private setSnapshot(next: DesktopAppState | null): void {
    this.snapshot = next;
    if (next && this.orchestrationRef === null) {
      // Only the FIRST full state seeds the ref — never regress it with a
      // stale seed's orchestration (orchestration-changed keeps it current).
      this.orchestrationRef = next.orchestrationChildren;
    }
  }

  /** IPC response path (getState / updateSnapshot): full DesktopAppState. */
  applySeedState(state: DesktopAppState): void {
    this.hasFullState = true;
    // applySnapshotIfNewer — strict < guard (equal revision is accepted).
    this.setSnapshot(this.snapshot && state.revision < this.snapshot.revision ? this.snapshot : state);
    // Re-merge the freshest orchestration, drain any buffered pre-seed full
    // (it reflects LATER main-process state than the mount-time seed even at
    // equal revision — session switches do not bump revision), then replay
    // any buffered pre-seed deltas in order.
    if (this.snapshot) {
      const pending = this.pendingFull;
      const latestOrchestration = this.orchestrationRef ?? this.snapshot.orchestrationChildren;
      let next: DesktopAppState = this.snapshot;
      if (pending !== null && pending.revision >= this.snapshot.revision) {
        this.pendingFull = null;
        next = { ...pending, orchestrationChildren: latestOrchestration };
      } else if (pending !== null) {
        this.pendingFull = null; // stale pending superseded by the seed
      } else if (this.snapshot.orchestrationChildren !== latestOrchestration) {
        next = { ...this.snapshot, orchestrationChildren: latestOrchestration };
      }
      if (this.pendingDeltas.length > 0) {
        const buffered = this.pendingDeltas;
        this.pendingDeltas = [];
        for (const payload of buffered) {
          // Skip deltas that are NOT newer than the already-applied state
          // (their changes are inside a later buffered full) — the pure
          // applyStateDelta has no revision guard.
          if (payload.revision <= next.revision) {
            continue;
          }
          next = applyStateDelta(next, payload.ops);
        }
      }
      this.setSnapshot(next);
    }
  }

  /** Pushed full state-changed: orchestration-stripped, completed from the ref. */
  applyStateChanged(slices: StateSlices): void {
    const next = (() => {
      if (this.snapshot && slices.revision < this.snapshot.revision) {
        return this.snapshot;
      }
      if (this.pendingFull !== null && slices.revision >= this.pendingFull.revision) {
        this.pendingFull = null; // applied or superseded
      }
      if (!this.hasFullState) {
        // Seed-before-apply: no full DesktopAppState has arrived yet — buffer
        // the latest pushed full instead of dropping it.
        this.pendingFull = slices;
        return this.snapshot;
      }
      if (!this.snapshot) {
        this.pendingFull = slices;
        return this.snapshot;
      }
      return { ...slices, orchestrationChildren: this.orchestrationRef ?? this.snapshot.orchestrationChildren };
    })();
    this.setSnapshot(next);
  }

  /** Pushed state-delta: <= guard (equal revision is a duplicate). */
  applyStateDelta(payload: StateDeltaPayload): void {
    const next = (() => {
      if (!this.snapshot || !this.hasFullState) {
        // Cardo: pre-seed delta — buffer it (relative to the buffered full's
        // state); replayed by the seed drain so it is never lost.
        this.pendingDeltas.push(payload);
        return this.snapshot;
      }
      if (payload.revision <= this.snapshot.revision) {
        return this.snapshot;
      }
      return applyStateDelta(this.snapshot, payload.ops);
    })();
    this.setSnapshot(next);
  }

  /** Pushed orchestration-changed: update ref first, then merge one slice. */
  applyOrchestrationChanged(children: readonly OrchestrationChildThread[]): void {
    this.orchestrationRef = children;
    this.setSnapshot(this.snapshot ? { ...this.snapshot, orchestrationChildren: children } : this.snapshot);
  }

  /** Pushed full transcript. */
  applyTranscriptChanged(record: SelectedTranscriptRecord): void {
    this.receivedPushedTranscript = true;
    this.selectedTranscript = record;
  }

  /** Pushed transcript-delta: session-match guard, no revision. */
  applyTranscriptDelta(payload: TranscriptDeltaPayload): void {
    this.receivedPushedTranscript = true;
    if (
      !this.selectedTranscript ||
      this.selectedTranscript.workspaceId !== payload.workspaceId ||
      this.selectedTranscript.sessionId !== payload.sessionId
    ) {
      return;
    }
    this.selectedTranscript = {
      ...this.selectedTranscript,
      transcript: applyTranscriptDelta(this.selectedTranscript.transcript, payload.ops),
    };
  }

  /** Initial Promise.all([getState(), getSelectedTranscript()]) resolution. */
  applyInitial(state: DesktopAppState, transcript: SelectedTranscriptRecord): void {
    this.applySeedState(state);
    if (!this.receivedPushedTranscript) {
      this.selectedTranscript = transcript;
    }
  }

  process(delivery: Delivery): void {
    switch (delivery.kind) {
      case "state-changed":
        this.applyStateChanged(delivery.slices);
        break;
      case "state-delta":
        this.applyStateDelta(delivery.payload);
        break;
      case "orchestration-changed":
        this.applyOrchestrationChanged(delivery.orchestrationChildren);
        break;
      case "transcript-changed":
        this.applyTranscriptChanged(delivery.record);
        break;
      case "transcript-delta":
        this.applyTranscriptDelta(delivery.payload);
        break;
    }
  }
}

/* ── publisher (mirrors main.ts publishStateToWindow) ───── */

interface PublisherState {
  lastState?: PublishedStateSnapshot;
  lastTranscript?: PublishedTranscriptSnapshot;
  lastOrchestration?: readonly OrchestrationChildThread[];
}

function publishWindow(
  pub: PublisherState,
  storeState: DesktopAppState,
  caches: FlowCaches,
): Delivery[] {
  const deliveries: Delivery[] = [];
  const slices = stateSlicesWithoutOrchestration(storeState);
  const stateDelivery = decideStateDelivery(pub.lastState, slices);
  if (stateDelivery.kind === "full") {
    deliveries.push({ kind: "state-changed", slices });
  } else if (stateDelivery.ops.length > 0) {
    deliveries.push({
      kind: "state-delta",
      payload: { revision: storeState.revision, ops: stateDelivery.ops },
    });
  }
  pub.lastState = { revision: storeState.revision, slices };

  const selectedKey = sessionKey({
    workspaceId: storeState.selectedWorkspaceId,
    sessionId: storeState.selectedSessionId,
  });
  const items = transcriptOf(caches, selectedKey);
  const current = {
    workspaceId: storeState.selectedWorkspaceId,
    sessionId: storeState.selectedSessionId,
    items,
  };
  const transcriptDelivery = decideTranscriptDelivery(pub.lastTranscript, current);
  if (transcriptDelivery.kind === "full") {
    deliveries.push({
      kind: "transcript-changed",
      record: { workspaceId: current.workspaceId, sessionId: current.sessionId, transcript: items },
    });
  } else if (transcriptDelivery.ops.length > 0) {
    deliveries.push({
      kind: "transcript-delta",
      payload: { workspaceId: current.workspaceId, sessionId: current.sessionId, ops: transcriptDelivery.ops },
    });
  }
  pub.lastTranscript = current;

  if (storeState.orchestrationChildren !== pub.lastOrchestration) {
    deliveries.push({ kind: "orchestration-changed", orchestrationChildren: storeState.orchestrationChildren });
    pub.lastOrchestration = storeState.orchestrationChildren;
  }

  return deliveries;
}

/* ── deterministic shuffle (channel delivery order is arbitrary) ── */

function shuffledOrder(length: number, seed: number): number[] {
  const order = Array.from({ length }, (_, index) => index);
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/* ── assertions ────────────────────────────────────────── */

function sameSlices(a: StateSlices, b: StateSlices): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameTranscript(a: readonly TranscriptMessage[], b: readonly TranscriptMessage[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertRendererConverged(
  renderer: RendererSim,
  storeState: DesktopAppState,
  caches: FlowCaches,
  message: string,
): void {
  assert.ok(renderer.snapshot !== null, `${message}: renderer snapshot seeded`);
  const rendererSlices = stateSlicesWithoutOrchestration(renderer.snapshot);
  const storeSlices = stateSlicesWithoutOrchestration(storeState);
  assert.ok(sameSlices(rendererSlices, storeSlices), `${message}: state slices converge`);
  assert.deepEqual(
    renderer.snapshot.orchestrationChildren,
    storeState.orchestrationChildren,
    `${message}: orchestrationChildren converge`,
  );
  assert.equal(renderer.snapshot.revision, storeState.revision, `${message}: revision converges`);

  const selectedKey = sessionKey({
    workspaceId: storeState.selectedWorkspaceId,
    sessionId: storeState.selectedSessionId,
  });
  assert.ok(renderer.selectedTranscript !== null, `${message}: renderer transcript seeded`);
  assert.equal(renderer.selectedTranscript.workspaceId, storeState.selectedWorkspaceId, `${message}: transcript ws`);
  assert.equal(renderer.selectedTranscript.sessionId, storeState.selectedSessionId, `${message}: transcript session`);
  assert.ok(
    sameTranscript(renderer.selectedTranscript.transcript, transcriptOf(caches, selectedKey)),
    `${message}: transcript converges`,
  );
}

/* ── scenario runner ───────────────────────────────────── */

interface WindowStep {
  events: SessionDriverEvent[];
  switchTo?: string;
  orchestrate?: boolean;
}

interface Scenario {
  label: string;
  windows: WindowStep[];
  seedAtWindow: number;
  reloadAtWindow?: number;
  shuffleSeed: number;
}

function runScenario(scenario: Scenario): void {
  const caches = freshCaches();
  let storeState = makeInitialState();
  const pub: PublisherState = {};
  let renderer = new RendererSim();
  // Seed responses are built at mount from the INITIAL store (real ordering:
  // getState()/getSelectedTranscript() are sent at mount; their responses
  // cross the IPC boundary while the first pushes are already landing).
  const seedState = storeState;
  const seedTranscript: SelectedTranscriptRecord = {
    workspaceId: storeState.selectedWorkspaceId,
    sessionId: storeState.selectedSessionId,
    transcript: [],
  };
  let seedDelivered = false;

  for (let w = 0; w < scenario.windows.length; w += 1) {
    const step = scenario.windows[w];

    if (scenario.reloadAtWindow === w) {
      // Renderer (re)mount: fresh local state; the publisher clears its
      // last-published (startPublishing) so the next delivery is full.
      renderer = new RendererSim();
      pub.lastState = undefined;
      pub.lastTranscript = undefined;
      pub.lastOrchestration = undefined;
      seedDelivered = false; // the reloaded renderer re-sends getState()
    }

    // Fold the window's events into the store (coalesced: only the last
    // event's state is published — trailing-edge latest).
    for (const event of step.events) {
      driveEvent(caches, event);
      storeState = applySessionEventState(
        storeState,
        event,
        caches.transcriptCache,
        caches.runningSinceBySession,
        caches.lastViewedAtBySession,
      );
    }
    if (step.switchTo !== undefined) {
      storeState = { ...storeState, selectedSessionId: step.switchTo };
    }
    if (step.orchestrate) {
      const child: OrchestrationChildThread = {
        id: `child-${w}`,
        parentWorkspaceId: WS_ID,
        parentSessionId: SESSION_A,
        childWorkspaceId: WS_ID,
        childSessionId: `child-session-${w}`,
        title: `child ${w}`,
        goal: `goal ${w}`,
        status: "running",
        latestTranscript: "child text",
        transcript: [],
        evidence: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      storeState = { ...storeState, orchestrationChildren: [...storeState.orchestrationChildren, child] };
    }

    const deliveries = publishWindow(pub, storeState, caches);
    for (const index of shuffledOrder(deliveries.length, scenario.shuffleSeed + w)) {
      renderer.process(deliveries[index]);
    }

    // The mount-time seed response resolves around here (races the pushes).
    if (!seedDelivered && w >= scenario.seedAtWindow) {
      renderer.applyInitial(seedState, seedTranscript);
      seedDelivered = true;
    }

    // Convergence must hold after every window once the renderer is seeded.
    if (renderer.snapshot !== null && renderer.selectedTranscript !== null) {
      assertRendererConverged(renderer, storeState, caches, `${scenario.label} window ${w}`);
    }
  }
}

/* ── properties ────────────────────────────────────────── */

test("W-CONV/W-REV/W-TOT: long single-session task — any batching, any interleaving, seed race", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(deltaEventArb, { minLength: 0, maxLength: 6 }), { minLength: 2, maxLength: 12 }),
      fc.integer({ min: 0, max: 3 }),
      fc.boolean(),
      fc.integer(),
      (windows, seedOffset, orchestrateSome, shuffleSeed) => {
        const scenario: Scenario = {
          label: "long-task",
          windows: windows.map((events, index) => ({
            events,
            orchestrate: orchestrateSome && index % 4 === 3,
          })),
          seedAtWindow: seedOffset,
          shuffleSeed,
        };
        // The whole scenario must never throw (white-screen class).
        runScenario(scenario);
      },
    ),
    { numRuns: 200 },
  );
});

test("W-CONV: session switch mid-run forces fulls and stays converged", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(deltaEventArb, { minLength: 0, maxLength: 4 }), { minLength: 3, maxLength: 10 }),
      fc.integer({ min: 0, max: 2 }),
      fc.array(fc.boolean(), { minLength: 0, maxLength: 10 }),
      fc.integer(),
      (windows, seedOffset, switches, shuffleSeed) => {
        const scenario: Scenario = {
          label: "switch",
          windows: windows.map((events, index) => ({
            events,
            switchTo: switches[index % switches.length] ? SESSION_B : SESSION_A,
          })),
          seedAtWindow: seedOffset,
          shuffleSeed,
        };
        runScenario(scenario);
      },
    ),
    { numRuns: 200 },
  );
});

test("W-REL: renderer reload mid-task forces full resend and re-converges", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(deltaEventArb, { minLength: 1, maxLength: 4 }), { minLength: 4, maxLength: 10 }),
      fc.integer({ min: 0, max: 2 }),
      fc.integer({ min: 2, max: 5 }),
      fc.integer(),
      (windows, seedOffset, reloadAt, shuffleSeed) => {
        const scenario: Scenario = {
          label: "reload",
          windows: windows.map((events) => ({ events })),
          seedAtWindow: seedOffset,
          reloadAtWindow: reloadAt,
          shuffleSeed,
        };
        runScenario(scenario);
      },
    ),
    { numRuns: 200 },
  );
});

test("W-ID: slices and transcript items untouched by the last delta keep object identity", () => {
  fc.assert(
    fc.property(
      fc.array(deltaEventArb, { minLength: 1, maxLength: 8 }),
      (events) => {
        const caches = freshCaches();
        let storeState = makeInitialState();
        const pub: PublisherState = {};
        const renderer = new RendererSim();
        renderer.applySeedState(storeState);
        renderer.applyTranscriptChanged({
          workspaceId: storeState.selectedWorkspaceId,
          sessionId: storeState.selectedSessionId,
          transcript: [],
        });

        for (const event of events) {
          driveEvent(caches, event);
          storeState = applySessionEventState(
            storeState,
            event,
            caches.transcriptCache,
            caches.runningSinceBySession,
            caches.lastViewedAtBySession,
          );
          const deliveries = publishWindow(pub, storeState, caches);
          for (const delivery of deliveries) {
            const snapshotBefore = renderer.snapshot;
            const transcriptBefore = renderer.selectedTranscript?.transcript ?? [];
            renderer.process(delivery);
            if (delivery.kind === "state-delta" && snapshotBefore) {
              const opKeys = new Set(delivery.payload.ops.map((op) => op.key));
              for (const key of Object.keys(snapshotBefore) as (keyof DesktopAppState)[]) {
                if (!opKeys.has(key as never)) {
                  assert.equal(
                    renderer.snapshot?.[key],
                    snapshotBefore[key],
                    `untouched slice ${String(key)} keeps identity`,
                  );
                }
              }
            }
            if (delivery.kind === "transcript-delta" && renderer.selectedTranscript) {
              const opIds = new Set(
                delivery.payload.ops.map((op) => (op.kind === "upsert" ? op.item.id : op.id)),
              );
              const after = renderer.selectedTranscript.transcript;
              const beforeById = new Map(transcriptBefore.map((item, index) => [item.id, { item, index }]));
              for (let index = 0; index < after.length; index += 1) {
                const prior = beforeById.get(after[index].id);
                if (prior && !opIds.has(after[index].id)) {
                  assert.equal(after[index], prior.item, `untouched transcript item ${after[index].id} keeps identity`);
                }
              }
            }
          }
        }
        assertRendererConverged(renderer, storeState, caches, "identity end-state");
      },
    ),
    { numRuns: 100 },
  );
});
