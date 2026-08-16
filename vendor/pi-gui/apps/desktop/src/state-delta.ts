// Cardo: state snapshot + delta delivery — the state-channel counterpart of
// transcript-delta.ts.
//
// publishStateToWindow serializes the whole DesktopAppState on every coalesced
// push, including orchestrationChildren — complete child-thread transcripts +
// evidence — which dominates the payload. On long orchestration runs the
// per-push payload grows without bound even when nothing the renderer displays
// has changed.
//
// This module implements the snapshot + delta fix for the STATE channel: the
// main process ships the full (orchestration-stripped) state once per session
// selection / renderer recovery, and afterwards ships only the CHANGED slices
// on a separate state-delta channel; orchestrationChildren leaves the per-push
// payload entirely and arrives on its own orchestration-changed channel
// (reference-changed only). Each push is O(changed slices) instead of O(all).
//
// The diff is reference-accelerated, exactly like the transcript delta: T1
// removed the per-push structuredClone from projectStateForView, so projected
// slices keep object identity across pushes; `computeStateDelta` compares each
// slice by reference (O(1) skip) and only emits an op for slices that actually
// changed. `applyStateDelta` on the renderer side keeps the objects of
// untouched slices, so memo comparators short-circuit on reference equality
// instead of re-rendering the whole surface per push.
//
// All functions are pure so the PBT suite can verify the whole behavior as
// invariants (byte-compatible convergence vs the full-snapshot path, identity
// of untouched slices, delivery decisions, orchestration exclusion, revision
// handling).

import type { DesktopAppState } from "./desktop-state";

/** Every DesktopAppState slice except orchestrationChildren (own channel). */
export type StateDeltaSliceKey = Exclude<keyof DesktopAppState, "orchestrationChildren">;

/** The state content that rides the state channels (never orchestrationChildren). */
export type StateSlices = Pick<DesktopAppState, StateDeltaSliceKey>;

export interface StateDeltaOp {
  readonly kind: "set";
  readonly key: StateDeltaSliceKey;
  /** undefined ⇒ the key is DELETED on apply (absent, not undefined). */
  readonly value: DesktopAppState[StateDeltaSliceKey];
}

export interface StateDeltaPayload {
  /** The store revision the ops advance the renderer TO (stale/dup guard). */
  readonly revision: number;
  readonly ops: readonly StateDeltaOp[];
}

export interface PublishedStateSnapshot {
  /** Revision of the last delivered state. */
  readonly revision: number;
  /** Reference-stable — NEVER deep-copied (T1's clone removal makes this sound). */
  readonly slices: StateSlices;
}

export type StateDelivery =
  /** Send the full (orchestration-stripped) state (session switch / first publish / recovery). */
  | { readonly kind: "full" }
  /** Send only the changed slices; empty ops means nothing changed (skip send). */
  | { readonly kind: "delta"; readonly ops: readonly StateDeltaOp[] };

/**
 * Pure delivery decision mirroring electron/main.ts's per-window publish path:
 * a full snapshot whenever the selected workspace/session differs from the
 * last published one (or nothing was published yet), otherwise an incremental
 * delta. When the delta is empty the caller skips the send entirely — no work,
 * no payload.
 */
export function decideStateDelivery(
  last: PublishedStateSnapshot | undefined,
  current: StateSlices | null,
): StateDelivery {
  if (current === null) {
    return { kind: "full" };
  }
  if (
    last === undefined ||
    last.slices.selectedWorkspaceId !== current.selectedWorkspaceId ||
    last.slices.selectedSessionId !== current.selectedSessionId
  ) {
    return { kind: "full" };
  }
  return { kind: "delta", ops: computeStateDelta(last.slices, current) };
}

/**
 * Reference-accelerated diff over the slice keys present on either object:
 * only slices whose reference changed produce ops (revision included — it
 * changes on every push). orchestrationChildren NEVER appears (it is not a
 * StateDeltaSliceKey). A key present on `previous` but absent on `current`
 * yields an op with `value: undefined` (delete on apply).
 */
export function computeStateDelta(previous: StateSlices, current: StateSlices): readonly StateDeltaOp[] {
  const keys = new Set<StateDeltaSliceKey>();
  for (const key of Object.keys(previous)) {
    keys.add(key as StateDeltaSliceKey);
  }
  for (const key of Object.keys(current)) {
    keys.add(key as StateDeltaSliceKey);
  }
  const ops: StateDeltaOp[] = [];
  for (const key of keys) {
    if (previous[key] === current[key]) {
      continue;
    }
    ops.push({ kind: "set", key, value: current[key] });
  }
  return ops;
}

/**
 * Renderer-side apply. Slices not touched by any op keep their object identity
 * (memo short-circuit). An op with `value === undefined` DELETES the key from
 * the resulting state (absent, never present-with-undefined).
 */
export function applyStateDelta(current: DesktopAppState, ops: readonly StateDeltaOp[]): DesktopAppState {
  let next: DesktopAppState = current;
  for (const op of ops) {
    if (op.kind !== "set") {
      continue;
    }
    const previousValue = next[op.key];
    if (op.value === undefined) {
      // Delete semantics: the key becomes ABSENT (≠ a present `undefined`).
      if (previousValue === undefined && !(op.key in next)) {
        continue;
      }
      const { [op.key]: _dropped, ...rest } = next;
      next = rest as DesktopAppState;
      continue;
    }
    if (previousValue === op.value) {
      continue;
    }
    next = { ...next, [op.key]: op.value };
  }
  return next;
}

/**
 * Drop the orchestrationChildren slice via destructuring — the key is ABSENT
 * on the result (never present-with-undefined), so `"orchestrationChildren" in
 * slices` is false. All other slices keep their object identity.
 */
export function stateSlicesWithoutOrchestration(state: DesktopAppState): StateSlices {
  const { orchestrationChildren: _orchestrationChildren, ...slices } = state;
  return slices;
}
