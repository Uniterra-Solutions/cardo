// Cardo: transcript delta protocol — snapshot + incremental delivery.
//
// The driver emits one event per text delta and the store re-publishes the full
// transcript per event; on long tasks the renderer falls irrecoverably behind
// (agent finishes, UI still replaying the backlog). The coalesced publisher
// (electron/stream-publish.ts) bounds push RATE but not payload SIZE — each
// push still serializes the whole transcript (O(n)), and the renderer rebuilds
// the timeline from it on every snapshot.
//
// This module implements the snapshot + delta fix: the main process ships the
// full transcript once per session selection (existing selectedTranscriptChanged
// channel) and afterwards ships only the CHANGED items (upsert / remove) on a
// separate transcript-delta channel. Each push is O(changed) instead of O(n).
//
// The diff is reference-accelerated: the store's transcript cache is
// immutable-style (every mutation spreads + replaces, never mutates), so items
// that did not change keep their object identity across events. `compute`
// compares by reference first (O(1) skip) and falls back to content comparison
// only for items that were actually replaced; `apply` on the renderer side
// keeps the objects of untouched items, so the timeline's memo comparator can
// short-circuit on reference equality instead of JSON.stringify-ing every row.
//
// All functions are pure so the PBT suite can verify the whole behavior as
// invariants (convergence, no-loss/no-dup content accounting, id/kind
// stability, per-delta cost bounded independent of transcript length).

import type { TranscriptMessage } from "./desktop-state";

export type TranscriptDeltaOp =
  /** Replace-or-append the item with the same id (changed or new). */
  | { readonly kind: "upsert"; readonly item: TranscriptMessage }
  /** Remove the item with this id (the only removals are the "Working…" activity rows). */
  | { readonly kind: "remove"; readonly id: string };

export interface TranscriptDeltaPayload {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly ops: readonly TranscriptDeltaOp[];
}

/**
 * What the main process last sent to a given window, used to decide whether the
 * next delivery is a full snapshot (session switched / never published) or an
 * incremental delta.
 */
export interface PublishedTranscriptSnapshot {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** The immutable cache array as of the last delivery (reference-stable). */
  readonly items: readonly TranscriptMessage[];
}

export type TranscriptDelivery =
  /** Send the full SelectedTranscriptRecord (session switch / first publish). */
  | { readonly kind: "full" }
  /** Send only the changed items; empty ops means nothing changed (skip send). */
  | { readonly kind: "delta"; readonly ops: readonly TranscriptDeltaOp[] };

/**
 * Pure delivery decision mirroring electron/main.ts's per-window publish path:
 * a full snapshot whenever the selected session differs from the last published
 * one (or nothing was published yet), otherwise an incremental delta. When the
 * delta is empty the caller skips the send entirely — no work, no payload.
 */
export function decideTranscriptDelivery(
  last: PublishedTranscriptSnapshot | undefined,
  current: { readonly workspaceId: string; readonly sessionId: string; readonly items: readonly TranscriptMessage[] } | null,
): TranscriptDelivery {
  if (current === null) {
    return { kind: "full" };
  }
  if (
    last === undefined ||
    last.workspaceId !== current.workspaceId ||
    last.sessionId !== current.sessionId
  ) {
    return { kind: "full" };
  }
  return { kind: "delta", ops: computeTranscriptDelta(last.items, current.items) };
}

/**
 * Deep content comparison for transcript items. Used by `compute` to detect
 * real changes behind replaced references and by the timeline memo comparator
 * to avoid JSON.stringify on every row.
 */
export function sameTranscriptItemContent(a: TranscriptMessage, b: TranscriptMessage): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind || a.id !== b.id) {
    return false;
  }
  switch (a.kind) {
    case "message": {
      const other = b as Extract<TranscriptMessage, { kind: "message" }>;
      return (
        a.role === other.role &&
        a.text === other.text &&
        a.createdAt === other.createdAt &&
        sameAttachments(a.attachments, other.attachments)
      );
    }
    case "thinking": {
      const other = b as Extract<TranscriptMessage, { kind: "thinking" }>;
      return (
        a.text === other.text &&
        a.createdAt === other.createdAt &&
        a.startedAt === other.startedAt &&
        a.endedAt === other.endedAt
      );
    }
    case "tool": {
      const other = b as Extract<TranscriptMessage, { kind: "tool" }>;
      return (
        a.callId === other.callId &&
        a.toolName === other.toolName &&
        a.status === other.status &&
        a.label === other.label &&
        a.detail === other.detail &&
        a.metadata === other.metadata &&
        a.createdAt === other.createdAt &&
        sameJson(a.input, other.input) &&
        sameJson(a.output, other.output)
      );
    }
    case "activity": {
      const other = b as Extract<TranscriptMessage, { kind: "activity" }>;
      return (
        a.createdAt === other.createdAt &&
        a.label === other.label &&
        a.detail === other.detail &&
        a.metadata === other.metadata &&
        a.tone === other.tone
      );
    }
    case "summary": {
      const other = b as Extract<TranscriptMessage, { kind: "summary" }>;
      return (
        a.createdAt === other.createdAt &&
        a.label === other.label &&
        a.metadata === other.metadata &&
        a.presentation === other.presentation
      );
    }
    default:
      return false;
  }
}

function sameAttachments(
  a: Extract<TranscriptMessage, { kind: "message" }>["attachments"],
  b: Extract<TranscriptMessage, { kind: "message" }>["attachments"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!sameJson(a[index], b[index])) {
      return false;
    }
  }
  return true;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null || typeof a !== "object") {
    return false;
  }
  // Fall back to stringify only for arbitrary JSON payloads (tool input/output,
  // attachments). These are usually small; the reference fast-path covers the
  // common unchanged case.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compute the ops that transform `previous` into `current`. Both arrays come
 * from the store's immutable transcript cache; unchanged items share object
 * identity so the reference fast-path skips them in O(1).
 */
export function computeTranscriptDelta(
  previous: readonly TranscriptMessage[],
  current: readonly TranscriptMessage[],
): readonly TranscriptDeltaOp[] {
  const ops: TranscriptDeltaOp[] = [];
  const previousById = new Map<string, TranscriptMessage>();
  for (const item of previous) {
    previousById.set(item.id, item);
  }
  const currentById = new Map<string, TranscriptMessage>();
  for (const item of current) {
    currentById.set(item.id, item);
  }

  for (const item of current) {
    const previousItem = previousById.get(item.id);
    if (previousItem === undefined) {
      // New item: append.
      ops.push({ kind: "upsert", item });
      continue;
    }
    if (previousItem === item || sameTranscriptItemContent(previousItem, item)) {
      // Unchanged (reference-identical, or content-equal after a replace).
      continue;
    }
    ops.push({ kind: "upsert", item });
  }

  for (const item of previous) {
    if (!currentById.has(item.id)) {
      ops.push({ kind: "remove", id: item.id });
    }
  }

  return ops;
}

/**
 * Apply ops to the renderer's local transcript. Items not touched by any op
 * keep their object identity so the timeline memo comparator short-circuits on
 * reference equality.
 */
export function applyTranscriptDelta(
  current: readonly TranscriptMessage[],
  ops: readonly TranscriptDeltaOp[],
): readonly TranscriptMessage[] {
  const next = [...current];
  const indexById = new Map<string, number>();
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index];
    if (item) {
      indexById.set(item.id, index);
    }
  }

  for (const op of ops) {
    if (op.kind === "remove") {
      const index = indexById.get(op.id);
      if (index !== undefined) {
        next.splice(index, 1);
        indexById.delete(op.id);
        for (let after = index; after < next.length; after += 1) {
          const item = next[after];
          if (item) {
            indexById.set(item.id, after);
          }
        }
      }
      continue;
    }
    const index = indexById.get(op.item.id);
    if (index === undefined) {
      next.push(op.item);
      indexById.set(op.item.id, next.length - 1);
    } else {
      next[index] = op.item;
    }
  }

  return next;
}
