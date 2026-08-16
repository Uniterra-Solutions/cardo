import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionTranscriptItem } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionQueuedMessage, SessionRef } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../src/desktop-state";
import {
  formatElapsedDuration,
  makeActivityItem,
  makeSummaryItem,
  makeThinkingItem,
  makeToolItem,
  makeTranscriptMessage,
  makeTranscriptMessageWithAttachments,
} from "./app-store-utils";
import {
  createChildThreadToolName,
  listThreadsToolName,
  readThreadToolName,
  sendMessageToThreadToolName,
} from "./orchestration-runtime";

export interface RunMetrics {
  readonly startedAt: string;
  toolCount: number;
  searchCount: number;
  fileCount: number;
}

interface TimelineRuntimeState {
  readonly runMetricsBySession: Map<string, RunMetrics>;
  readonly runningSinceBySession: Map<string, string>;
  readonly activeAssistantMessageBySession: Map<string, string>;
  readonly activeWorkingActivityBySession: Map<string, string>;
  readonly activeThinkingBySession: Map<string, ActiveThinkingRecord>;
}

// Cardo: in-progress reasoning block accumulated from assistantThinkingDelta events.
export interface ActiveThinkingRecord {
  readonly id: string;
  readonly text: string;
  readonly startedAt: string;
}

// Cardo: real-time streaming refactor (T1 — store liveness). The transcript
// cache value is now a persistent, chunked structure instead of a plain array
// rebuilt by spreading the whole transcript on every driver event. Mutations
// below mutate the entry IN PLACE (no per-event Map.set), so the full fold path
// (timeline mutations + applySessionEventState) is linear: each event rebuilds
// at most one TRANSCRIPT_CHUNK_SIZE chunk instead of the whole accumulated
// transcript.
//
// The entry is structurally assignable to `readonly TranscriptMessage[]`
// (implements the full ReadonlyArray surface), so all array-semantics
// consumers (previewFromTranscript, latestSessionActivityAt,
// hasUnseenSessionUpdate, updateSessionRecord, buildWorkspaceRecords,
// buildSessionRecord, the timeline helpers) compile and behave unchanged.
//
// Streaming text (the active assistant message and the active thinking block)
// is stored as a PARTS list (string[] appended per delta) with a rope-cached
// joined text; the item object is only materialized with the joined text at
// finalize (killing the per-delta O(text²) concat). The index accessor and
// toArray() return a synthesized view carrying the CURRENT joined text — the
// view object is replaced on each append (so the reference-accelerated delta
// diff still sees growth) and reused between appends (so the J contract —
// content-unchanged items keep object identity — holds even when streaming
// stalls). Retired views stay in a per-id map so a message whose streaming was
// cut short (tool started, queued message, run end) never exposes stale
// first-part text and keeps its identity.

/** Cardo: chunk size for the persistent transcript — the K′ per-event element-copy budget. */
export const TRANSCRIPT_CHUNK_SIZE = 64;

interface ActiveStreamRecord {
  readonly parts: string[];
  currentText: string;
  /** Synthesized view of the in-flight item: replaced on each append, reused between appends. */
  view: TranscriptMessage;
}

const NUMERIC_INDEX = /^(0|[1-9]\d*)$/;

// Cardo: the entry's numeric index access (`entry[i]`, used by
// previewFromTranscript's backward scan and latestErrorToolDetail) is served
// through a one-time Proxy that maps the numeric property to O(log #chunks)
// positional access on the target. All other properties fall through to the
// class, so the entry stays a normal object for identity checks and the K
// harness can wrap it in another Proxy.
function wrapEntry(entry: TranscriptCacheEntry): TranscriptCacheEntry {
  return new Proxy(entry, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && NUMERIC_INDEX.test(prop)) {
        return target.itemAt(Number(prop));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Cardo: persistent transcript structure — chunked immutable-list storage with
 * an O(1) id index and streaming parts lists. Read surface is the full
 * `ReadonlyArray<TranscriptMessage>` contract (see the class doc header above);
 * the mutation surface is called by the timeline functions in this file only.
 */
export class TranscriptCacheEntry implements ReadonlyArray<TranscriptMessage> {
  declare private chunks: readonly (readonly TranscriptMessage[])[];
  declare private chunkStarts: readonly number[];
  declare private count: number;
  declare private idIndex: Map<string, { chunk: number; index: number }>;
  declare private viewsById: Map<string, ActiveStreamRecord>;

  constructor() {
    Object.defineProperty(this, "chunks", { value: [], writable: true });
    Object.defineProperty(this, "chunkStarts", { value: [], writable: true });
    Object.defineProperty(this, "count", { value: 0, writable: true });
    Object.defineProperty(this, "idIndex", { value: new Map() });
    Object.defineProperty(this, "viewsById", { value: new Map() });
  }

  static empty(): TranscriptCacheEntry {
    return wrapEntry(new TranscriptCacheEntry());
  }

  static fromArray(items: readonly TranscriptMessage[]): TranscriptCacheEntry {
    const entry = new TranscriptCacheEntry();
    for (const item of items) {
      entry.append(item);
    }
    return wrapEntry(entry);
  }

  get length(): number {
    return this.count;
  }

  /* ── mutation surface (timeline functions only) ─────────────────────── */

  /** O(1) amortized append; rebuilds at most the final chunk. */
  append(item: TranscriptMessage): void {
    const chunkCount = this.chunks.length;
    if (chunkCount === 0 || this.chunks[chunkCount - 1]!.length >= TRANSCRIPT_CHUNK_SIZE) {
      this.chunks = [...this.chunks, [item]];
      this.chunkStarts = [...this.chunkStarts, this.count];
    } else {
      const last = this.chunks[chunkCount - 1]!;
      this.chunks = [...this.chunks.slice(0, -1), [...last, item]];
    }
    this.idIndex.set(item.id, {
      chunk: this.chunks.length - 1,
      index: this.chunks[this.chunks.length - 1]!.length - 1,
    });
    this.count += 1;
  }

  /** O(1) id lookup via the maintained id→(chunk, index) index. */
  findById(id: string): TranscriptMessage | undefined {
    const pos = this.idIndex.get(id);
    if (!pos) {
      return undefined;
    }
    const item = this.chunks[pos.chunk]?.[pos.index];
    return item === undefined ? undefined : this.withView(item);
  }

  /** Replace-or-insert by id: rebuilds only the containing chunk (≤ TRANSCRIPT_CHUNK_SIZE). */
  replaceById(id: string, next: TranscriptMessage): void {
    const pos = this.idIndex.get(id);
    if (!pos) {
      return;
    }
    const chunk = this.chunks[pos.chunk];
    if (!chunk) {
      return;
    }
    const rebuilt = chunk.map((item, index) => (index === pos.index ? next : item));
    this.chunks = [...this.chunks.slice(0, pos.chunk), rebuilt, ...this.chunks.slice(pos.chunk + 1)];
    this.viewsById.delete(id);
  }

  /** Remove by id: rebuilds only the containing chunk; later chunk starts shift by one. */
  removeById(id: string): void {
    const pos = this.idIndex.get(id);
    if (!pos) {
      return;
    }
    const chunk = this.chunks[pos.chunk];
    if (!chunk) {
      return;
    }
    this.idIndex.delete(id);
    const rebuilt = chunk.filter((_, index) => index !== pos.index);
    for (let index = pos.index; index < rebuilt.length; index += 1) {
      const item = rebuilt[index]!;
      this.idIndex.set(item.id, { chunk: pos.chunk, index });
    }
    this.chunks = [...this.chunks.slice(0, pos.chunk), rebuilt, ...this.chunks.slice(pos.chunk + 1)];
    this.count -= 1;
    const starts = this.chunkStarts.slice();
    for (let chunkIndex = pos.chunk + 1; chunkIndex < starts.length; chunkIndex += 1) {
      starts[chunkIndex] = (starts[chunkIndex] ?? 0) - 1;
    }
    this.chunkStarts = starts;
    this.viewsById.delete(id);
  }

  /* ── streaming parts (active assistant message + thinking block) ────── */

  /** Whether `id` currently has a streaming parts record. */
  hasParts(id: string): boolean {
    return this.viewsById.has(id);
  }

  /** Begin streaming `text` for `id`; the stored `item` is the first-part seed. */
  beginParts(id: string, text: string, item: TranscriptMessage): void {
    // Cardo: the view is a shallow copy of the seed item with the CURRENT joined
    // text; cast is safe — beginParts is only ever called with message/thinking items.
    this.viewsById.set(id, { parts: [text], currentText: text, view: { ...item, text } as TranscriptMessage });
  }

  /** Append one delta part; O(1) rope-cached join; the view is replaced so the delta diff sees growth. */
  appendPart(id: string, text: string): void {
    const record = this.viewsById.get(id);
    if (!record) {
      return;
    }
    record.parts.push(text);
    record.currentText += text;
    record.view = { ...record.view, text: record.currentText } as TranscriptMessage;
  }

  /**
   * Materialize the stored item with the joined text (plus optional endedAt)
   * and drop the parts record. Content genuinely changes at finalize, so the
   * replacement object is exempt from the J identity contract.
   */
  finalizeParts(id: string, endedAt?: string): void {
    const record = this.viewsById.get(id);
    if (!record) {
      return;
    }
    const current = this.findById(id) ?? record.view;
    this.replaceById(
      id,
      {
        ...current,
        text: record.currentText,
        ...(endedAt ? { endedAt } : {}),
        // Cardo: cast is safe — finalizeParts is only called for message/thinking items.
      } as TranscriptMessage,
    );
    this.viewsById.delete(id);
  }

  /* ── internal read helpers ──────────────────────────────────────────── */

  /** Substitute the streaming view for items with an active parts record (retired views keep their object). */
  private withView(item: TranscriptMessage): TranscriptMessage {
    const record = this.viewsById.get(item.id);
    return record === undefined ? item : record.view;
  }

  /** Cardo: O(log #chunks) positional access (numeric index trap + preview scans). */
  itemAt(index: number): TranscriptMessage | undefined {
    if (index < 0 || index >= this.count) {
      return undefined;
    }
    let low = 0;
    let high = this.chunkStarts.length - 1;
    let chunkIndex = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((this.chunkStarts[mid] ?? 0) <= index) {
        chunkIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const chunk = this.chunks[chunkIndex]!;
    const item = chunk[index - (this.chunkStarts[chunkIndex] ?? 0)];
    return item === undefined ? undefined : this.withView(item);
  }

  /** Cardo: O(n) materialization — publish/persist rate ONLY, never per event. */
  toArray(): readonly TranscriptMessage[] {
    const out: TranscriptMessage[] = [];
    for (const chunk of this.chunks) {
      for (const item of chunk) {
        out.push(this.withView(item));
      }
    }
    return out;
  }

  /* ── ReadonlyArray surface (array-semantics consumers compile unchanged) ── */

  [index: number]: TranscriptMessage;

  [Symbol.iterator](): ArrayIterator<TranscriptMessage> {
    return this.iterate() as unknown as ArrayIterator<TranscriptMessage>;
  }

  private *iterate(): Generator<TranscriptMessage> {
    for (const chunk of this.chunks) {
      for (const item of chunk) {
        yield this.withView(item);
      }
    }
  }

  toString(): string {
    return this.toArray().toString();
  }

  toLocaleString(): string {
    return this.toArray().toLocaleString();
  }

  concat(...items: ConcatArray<TranscriptMessage>[]): TranscriptMessage[];
  concat(...items: (TranscriptMessage | ConcatArray<TranscriptMessage>)[]): TranscriptMessage[];
  concat(...items: (TranscriptMessage | ConcatArray<TranscriptMessage>)[]): TranscriptMessage[] {
    return this.toArray().concat(...(items as TranscriptMessage[]));
  }

  join(separator?: string): string {
    return this.toArray().join(separator);
  }

  slice(start?: number, end?: number): TranscriptMessage[] {
    return this.toArray().slice(start, end);
  }

  indexOf(searchElement: TranscriptMessage, fromIndex?: number): number {
    return this.toArray().indexOf(searchElement, fromIndex);
  }

  lastIndexOf(searchElement: TranscriptMessage, fromIndex?: number): number {
    return this.toArray().lastIndexOf(searchElement, fromIndex);
  }

  every<S extends TranscriptMessage>(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => value is S,
    thisArg?: unknown,
  ): this is readonly S[];
  every(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): boolean;
  every(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): boolean {
    return this.toArray().every(predicate, thisArg as never);
  }

  some(predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown, thisArg?: unknown): boolean {
    return this.toArray().some(predicate, thisArg as never);
  }

  forEach(callbackfn: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => void, thisArg?: unknown): void {
    this.toArray().forEach(callbackfn, thisArg as never);
  }

  map<U>(callbackfn: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => U, thisArg?: unknown): U[] {
    return this.toArray().map(callbackfn, thisArg as never);
  }

  filter<S extends TranscriptMessage>(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => value is S,
    thisArg?: unknown,
  ): S[];
  filter(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): TranscriptMessage[];
  filter(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): TranscriptMessage[] {
    return this.toArray().filter(predicate, thisArg as never);
  }

  reduce(
    callbackfn: (previousValue: TranscriptMessage, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => TranscriptMessage,
  ): TranscriptMessage;
  reduce(
    callbackfn: (previousValue: TranscriptMessage, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => TranscriptMessage,
    initialValue: TranscriptMessage,
  ): TranscriptMessage;
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => U,
    initialValue: U,
  ): U;
  reduce(
    callbackfn: (previousValue: TranscriptMessage, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => TranscriptMessage,
    initialValue?: TranscriptMessage,
  ): TranscriptMessage {
    return initialValue === undefined
      ? this.toArray().reduce(callbackfn as never)
      : this.toArray().reduce(callbackfn as never, initialValue as never);
  }

  reduceRight(
    callbackfn: (previousValue: TranscriptMessage, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => TranscriptMessage,
  ): TranscriptMessage;
  reduceRight(
    callbackfn: (previousValue: TranscriptMessage, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => TranscriptMessage,
    initialValue: TranscriptMessage,
  ): TranscriptMessage;
  reduceRight<U>(
    callbackfn: (previousValue: U, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => U,
    initialValue: U,
  ): U;
  reduceRight(
    callbackfn: (previousValue: TranscriptMessage, currentValue: TranscriptMessage, currentIndex: number, array: readonly TranscriptMessage[]) => TranscriptMessage,
    initialValue?: TranscriptMessage,
  ): TranscriptMessage {
    return initialValue === undefined
      ? this.toArray().reduceRight(callbackfn as never)
      : this.toArray().reduceRight(callbackfn as never, initialValue as never);
  }

  find<S extends TranscriptMessage>(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => value is S,
    thisArg?: unknown,
  ): S | undefined;
  find(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): TranscriptMessage | undefined;
  find(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): TranscriptMessage | undefined {
    return this.toArray().find(predicate, thisArg as never);
  }

  findIndex(predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown, thisArg?: unknown): number {
    return this.toArray().findIndex(predicate, thisArg as never);
  }

  includes(searchElement: TranscriptMessage, fromIndex?: number): boolean {
    return this.toArray().includes(searchElement, fromIndex);
  }

  entries(): ArrayIterator<[number, TranscriptMessage]> {
    return this.toArray().entries() as unknown as ArrayIterator<[number, TranscriptMessage]>;
  }

  keys(): ArrayIterator<number> {
    return this.toArray().keys() as unknown as ArrayIterator<number>;
  }

  values(): ArrayIterator<TranscriptMessage> {
    return this.toArray().values() as unknown as ArrayIterator<TranscriptMessage>;
  }

  flatMap<U, This = undefined>(
    callback: (this: This, value: TranscriptMessage, index: number, array: TranscriptMessage[]) => U | ReadonlyArray<U>,
    thisArg?: This,
  ): U[] {
    return this.toArray().flatMap(callback as never, thisArg as never);
  }

  flat<A, D extends number = 1>(this: A, depth?: D): FlatArray<A, D>[] {
    return (this as unknown as readonly TranscriptMessage[]).flat(depth as number) as FlatArray<A, D>[];
  }

  at(index: number): TranscriptMessage | undefined {
    return this.itemAt(index < 0 ? this.count + index : index);
  }

  findLast<S extends TranscriptMessage>(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => value is S,
    thisArg?: unknown,
  ): S | undefined;
  findLast(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): TranscriptMessage | undefined;
  findLast(
    predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown,
    thisArg?: unknown,
  ): TranscriptMessage | undefined {
    const items = this.toArray();
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (predicate.call(thisArg, item, index, items as TranscriptMessage[])) {
        return item;
      }
    }
    return undefined;
  }

  findLastIndex(predicate: (value: TranscriptMessage, index: number, array: readonly TranscriptMessage[]) => unknown, thisArg?: unknown): number {
    const items = this.toArray();
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, items[index]!, index, items as TranscriptMessage[])) {
        return index;
      }
    }
    return -1;
  }

  toReversed(): TranscriptMessage[] {
    return [...this.toArray()].reverse();
  }

  toSorted(compareFn?: (a: TranscriptMessage, b: TranscriptMessage) => number): TranscriptMessage[] {
    return [...this.toArray()].sort(compareFn);
  }

  toSpliced(start: number, deleteCount: number, ...items: TranscriptMessage[]): TranscriptMessage[];
  toSpliced(start: number, deleteCount?: number): TranscriptMessage[];
  toSpliced(start: number, deleteCount?: number, ...items: TranscriptMessage[]): TranscriptMessage[] {
    const copy = [...this.toArray()];
    copy.splice(start, deleteCount ?? 0, ...items);
    return copy;
  }

  with(index: number, value: TranscriptMessage): TranscriptMessage[] {
    const copy = [...this.toArray()];
    copy[index] = value;
    return copy;
  }

  get [Symbol.unscopables](): { [K in keyof readonly TranscriptMessage[]]?: boolean } {
    return {};
  }
}

export function timelineFromDriverTranscript(items: readonly SessionTranscriptItem[]): TranscriptMessage[] {
  return items.map((item) => {
    if (item.kind === "thinking") {
      // Cardo: persisted thinking has no stream boundaries; render it finalized (collapsed).
      return {
        ...item,
        endedAt: item.createdAt,
      };
    }
    if (item.kind !== "tool") {
      return item;
    }
    const detail = detailFromOutput(item.output);
    return {
      ...makeToolItem(item.callId, item.toolName, item.status, toolLabel(item.toolName, item.input), {
        ...(detail !== undefined ? { detail } : {}),
        ...(item.input !== undefined ? { input: item.input } : {}),
        ...(item.output !== undefined ? { output: item.output } : {}),
      }),
      createdAt: item.createdAt,
    };
  });
}

// Cardo: fetch (creating + Map.set ONLY on first touch — the K′ set budget) or reuse the persistent entry.
function getOrCreateEntry(transcriptCache: Map<string, TranscriptCacheEntry>, key: string): TranscriptCacheEntry {
  const existing = transcriptCache.get(key);
  if (existing) {
    return existing;
  }
  const entry = TranscriptCacheEntry.empty();
  transcriptCache.set(key, entry);
  return entry;
}

export function appendUserMessage(
  transcriptCache: Map<string, TranscriptCacheEntry>,
  sessionRef: SessionRef,
  text: string,
  attachments: NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]> = [],
): string {
  const key = sessionKey(sessionRef);
  const entry = getOrCreateEntry(transcriptCache, key);
  const message =
    attachments.length > 0 ? makeTranscriptMessageWithAttachments("user", text, attachments) : makeTranscriptMessage("user", text);
  entry.append(message);
  return message.id;
}

export function appendQueuedUserMessage(
  transcriptCache: Map<string, TranscriptCacheEntry>,
  sessionRef: SessionRef,
  message: SessionQueuedMessage,
): void {
  const key = sessionKey(sessionRef);
  const entry = getOrCreateEntry(transcriptCache, key);
  const nextMessage = {
    kind: "message" as const,
    id: message.id,
    role: "user" as const,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
        }
      : {}),
  };

  // Cardo: O(1) id lookup replaces the full-array scan.
  if (entry.findById(message.id)) {
    entry.replaceById(message.id, nextMessage);
  } else {
    entry.append(nextMessage);
  }
}

export function appendAssistantDelta(
  transcriptCache: Map<string, TranscriptCacheEntry>,
  activeAssistantMessageBySession: Map<string, string>,
  sessionRef: SessionRef,
  text: string,
): void {
  const key = sessionKey(sessionRef);
  const entry = getOrCreateEntry(transcriptCache, key);
  const activeId = activeAssistantMessageBySession.get(key);

  if (activeId) {
    if (entry.hasParts(activeId)) {
      // Cardo: streaming continues — O(1) parts append (no per-delta string concat).
      entry.appendPart(activeId, text);
      return;
    }
    const existing = entry.findById(activeId);
    if (existing?.kind === "message") {
      // Cardo: defensive — the item exists but its parts record was lost; reseed from its text.
      entry.beginParts(activeId, `${existing.text ?? ""}${text}`, existing);
    } else {
      const message = makeTranscriptMessage("assistant", text);
      entry.append(message);
      activeAssistantMessageBySession.set(key, message.id);
      entry.beginParts(message.id, text, message);
    }
    return;
  }

  const message = makeTranscriptMessage("assistant", text);
  entry.append(message);
  activeAssistantMessageBySession.set(key, message.id);
  entry.beginParts(message.id, text, message);
}

export function clearActiveAssistantMessage(
  activeAssistantMessageBySession: Map<string, string>,
  sessionRef: SessionRef,
): void {
  activeAssistantMessageBySession.delete(sessionKey(sessionRef));
}

// Cardo: append a streaming reasoning delta to the active thinking block for the
// session, creating the block (and recording its start time) on first delta.
export function appendThinkingDelta(
  transcriptCache: Map<string, TranscriptCacheEntry>,
  activeThinkingBySession: Map<string, ActiveThinkingRecord>,
  sessionRef: SessionRef,
  text: string,
): void {
  const key = sessionKey(sessionRef);
  const entry = getOrCreateEntry(transcriptCache, key);
  const active = activeThinkingBySession.get(key);

  if (active) {
    if (entry.hasParts(active.id)) {
      // Cardo: streaming continues — O(1) parts append.
      entry.appendPart(active.id, text);
      return;
    }
    const existing = entry.findById(active.id);
    if (existing?.kind === "thinking") {
      // Cardo: defensive — the block exists but its parts record was lost; reseed from its text.
      entry.beginParts(active.id, `${existing.text ?? ""}${text}`, existing);
    } else {
      const item = makeThinkingItem(text);
      entry.append(item);
      entry.beginParts(item.id, text, item);
      activeThinkingBySession.set(key, { id: item.id, text, startedAt: item.startedAt ?? item.createdAt });
    }
    return;
  }

  const item = makeThinkingItem(text);
  entry.append(item);
  entry.beginParts(item.id, text, item);
  activeThinkingBySession.set(key, { id: item.id, text, startedAt: item.startedAt ?? item.createdAt });
}

// Cardo: finalize the session's active thinking block (if any): stamp `endedAt` so the
// UI collapses it, and drop the active record. No-op when nothing is streaming,
// so cache entries are left reference-identical.
export function finalizeActiveThinking(
  transcriptCache: Map<string, TranscriptCacheEntry>,
  activeThinkingBySession: Map<string, ActiveThinkingRecord>,
  sessionRef: SessionRef,
  endedAt?: string,
): void {
  const key = sessionKey(sessionRef);
  const active = activeThinkingBySession.get(key);
  if (!active) {
    return;
  }

  const entry = transcriptCache.get(key);
  if (entry && entry.hasParts(active.id)) {
    // Cardo: materialize the block with the rope-cached joined text + endedAt.
    entry.finalizeParts(active.id, endedAt ?? new Date().toISOString());
  }
  activeThinkingBySession.delete(key);
}

export function applyTimelineEvent(
  transcriptCache: Map<string, TranscriptCacheEntry>,
  event: SessionDriverEvent,
  state: TimelineRuntimeState,
): void {
  if (event.type === "assistantThinkingDelta") {
    // Reasoning deltas are appended by appendThinkingDelta (mirroring assistantDelta).
    return;
  }

  if (event.type === "assistantDelta") {
    // Text takes over from reasoning: collapse the thinking block, then let the
    // caller append the delta via appendAssistantDelta.
    finalizeActiveThinking(transcriptCache, state.activeThinkingBySession, event.sessionRef);
    return;
  }

  if (
    event.type === "toolStarted" ||
    event.type === "queuedMessageStarted" ||
    event.type === "runCompleted" ||
    event.type === "runFailed" ||
    event.type === "sessionClosed"
  ) {
    finalizeActiveThinking(transcriptCache, state.activeThinkingBySession, event.sessionRef);
  }

  const key = sessionKey(event.sessionRef);
  const entry = getOrCreateEntry(transcriptCache, key);
  const currentMetrics = state.runMetricsBySession.get(key);

  switch (event.type) {
    case "sessionOpened":
      entry.append(makeActivityItem("Resumed session", { metadata: relativeDetail(event.timestamp) }));
      break;
    case "sessionUpdated":
      if (event.snapshot.status === "running" && event.snapshot.runningRunId && !state.runningSinceBySession.has(key)) {
        state.runningSinceBySession.set(key, event.timestamp);
        state.runMetricsBySession.set(key, {
          startedAt: event.timestamp,
          toolCount: 0,
          searchCount: 0,
          fileCount: 0,
        });        
        const activity = makeActivityItem("Working…");
        state.activeWorkingActivityBySession.set(key, activity.id);
        entry.append(activity);
      }
      break;
    case "queuedMessageStarted":
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      appendQueuedUserMessage(transcriptCache, event.sessionRef, event.message);
      return;
    case "toolStarted": {
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      const metrics = currentMetrics ?? {
        startedAt: event.timestamp,
        toolCount: 0,
        searchCount: 0,
        fileCount: 0,
      };
      metrics.toolCount += 1;
      if (looksLikeSearch(event.toolName, event.input)) {
        metrics.searchCount += 1;
      }
      if (looksLikeFileExplore(event.toolName, event.input)) {
        metrics.fileCount += 1;
      }
      state.runMetricsBySession.set(key, metrics);
      upsertToolRow(entry, event.callId, event.toolName, "running", toolLabel(event.toolName, event.input), undefined, event.input);
      break;
    }
    case "toolUpdated":
      upsertToolRow(entry, event.callId, undefined, "running", undefined, event.text ?? progressLabel(event.progress));
      break;
    case "toolFinished":
      upsertToolRow(
        entry,
        event.callId,
        undefined,
        event.success ? "success" : "error",
        undefined,
        detailFromOutput(event.output),
        undefined,
        event.output,
      );
      break;
    case "runCompleted": {
      const metrics = currentMetrics;
      clearRunState(entry, key, event.sessionRef, state);
      if (metrics) {
        const label = summaryLabel(metrics);
        if (label) {
          entry.append(makeSummaryItem(label, { presentation: "inline" }));
        }
        entry.append(makeSummaryItem(workedForLabel(metrics.startedAt, event.timestamp), { presentation: "divider" }));
      } else {
        entry.append(makeSummaryItem("Completed", {
          presentation: "divider",
          metadata: relativeDetail(event.timestamp),
        }));
      }
      break;
    }
    case "runFailed": {
      const metrics = currentMetrics;
      const latestToolError = metrics ? latestErrorToolDetail(entry, metrics.startedAt) : undefined;
      const failureLabel = clearerRunFailureLabel(event.error.message, latestToolError);
      const failureDetail = event.error.code;
      clearRunState(entry, key, event.sessionRef, state);
      entry.append(
        makeActivityItem(failureLabel, {
          tone: "error",
          metadata: metrics ? workedForLabel(metrics.startedAt, event.timestamp) : undefined,
          detail: failureDetail,
        }),
      );
      break;
    }
    case "sessionClosed":
      clearRunState(entry, key, event.sessionRef, state);
      entry.append(makeActivityItem("Stopped", { metadata: relativeDetail(event.timestamp) }));
      break;
    case "hostUiRequest":
      if (event.request.kind === "notify") {
        entry.append(makeActivityItem(event.request.message, { metadata: relativeDetail(event.timestamp) }));
      }
      break;
    default:
      break;
  }
}

// Cardo: entry-level tool-row upsert — O(1) id lookup + O(chunk) replace (never a full-array rebuild).
function upsertToolRow(
  entry: TranscriptCacheEntry,
  callId: string,
  toolName?: string,
  status?: "running" | "success" | "error",
  label?: string,
  detail?: string,
  input?: unknown,
  output?: unknown,
) {
  const existing = entry.findById(callId);
  const existingTool = existing?.kind === "tool" ? existing : undefined;
  const next = makeToolItem(
    callId,
    toolName ?? (existingTool?.toolName ?? "tool"),
    status ?? (existingTool?.status ?? "running"),
    label ?? (existingTool?.label ?? "Working"),
    {
      detail: detail ?? existingTool?.detail,
      metadata: existingTool?.metadata,
      input: input ?? existingTool?.input,
      output: output ?? existingTool?.output,
    },
  );

  if (existingTool) {
    entry.replaceById(callId, {
      ...next,
      createdAt: existingTool.createdAt ?? next.createdAt,
    });
    return;
  }

  entry.append(next);
}

// Cardo: entry-level removal of the transient "Working…" activity row (O(chunk)).
function removeWorkingActivity(entry: TranscriptCacheEntry, activityId: string | undefined): void {
  if (!activityId) {
    return;
  }
  entry.removeById(activityId);
}

function clearRunState(
  entry: TranscriptCacheEntry,
  key: string,
  sessionRef: SessionRef,
  state: TimelineRuntimeState,
): void {
  clearActiveAssistantMessage(state.activeAssistantMessageBySession, sessionRef);
  removeWorkingActivity(entry, state.activeWorkingActivityBySession.get(key));
  state.activeWorkingActivityBySession.delete(key);
  state.runningSinceBySession.delete(key);
  state.runMetricsBySession.delete(key);
  state.activeThinkingBySession.delete(key);
}

function toolLabel(toolName: string, input: unknown): string {
  const detail = inputLabel(input);
  if (toolName === createChildThreadToolName) {
    return detail ? `Started child thread: ${detail}` : "Started child thread";
  }
  if (toolName === listThreadsToolName) {
    return "Listed threads";
  }
  if (toolName === readThreadToolName) {
    return detail ? `Read thread: ${detail}` : "Read thread";
  }
  if (toolName === sendMessageToThreadToolName) {
    return detail ? `Sent message to thread: ${detail}` : "Sent message to thread";
  }
  if (looksLikeSearch(toolName, input)) {
    return detail ? `Searched ${detail}` : `Searched with ${toolName}`;
  }
  if (looksLikeFileExplore(toolName, input)) {
    if (toolName.toLowerCase() === "read") {
      return detail ? `Read ${detail}` : "Read a file";
    }
    return detail ? `Explored ${detail}` : `Explored files with ${toolName}`;
  }
  return detail ? `Ran ${toolName}: ${detail}` : `Ran ${toolName}`;
}

function progressLabel(progress: number | undefined): string | undefined {
  if (progress === undefined) {
    return undefined;
  }
  if (progress <= 1) {
    return `${Math.round(progress * 100)}%`;
  }
  return String(progress);
}

function detailFromOutput(output: unknown): string | undefined {
  if (isRecord(output)) {
    const directError =
      stringProperty(output, "error") ?? stringProperty(output, "message") ?? stringProperty(output, "stderr");
    if (directError) {
      return summarizeToolDetail(directError);
    }
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    const text = output.content
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) {
      return summarizeToolDetail(text);
    }
  }
  if (typeof output === "string") {
    return summarizeToolDetail(output);
  }
  if (output === undefined || output === null) {
    return undefined;
  }
  return truncate(JSON.stringify(output));
}

function looksLikeSearch(toolName: string, input: unknown): boolean {
  if (toolName.toLowerCase().includes("search")) {
    return true;
  }
  return typeof input === "string" && /https?:\/\/|site:|query|search/i.test(input);
}

function looksLikeFileExplore(toolName: string, input: unknown): boolean {
  if (/(read|glob|ls|list|open)/i.test(toolName)) {
    return true;
  }
  return typeof input === "string" && /\/|\.md|\.ts|file/i.test(input);
}

function summaryLabel(metrics: RunMetrics): string | undefined {
  const parts: string[] = [];
  if (metrics.fileCount > 0) {
    parts.push(`Explored ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"}`);
  }
  if (metrics.searchCount > 0) {
    parts.push(`${metrics.searchCount} search${metrics.searchCount === 1 ? "" : "es"}`);
  }
  if (parts.length === 0 && metrics.toolCount > 0) {
    parts.push(`Used ${metrics.toolCount} tool${metrics.toolCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function workedForLabel(startedAt: string, endedAt: string): string {
  return `Worked for ${formatElapsedDuration(startedAt, endedAt)}`;
}

function relativeDetail(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function truncate(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function summarizeToolDetail(value: string): string {
  return truncate(value);
}

function inputLabel(input: unknown): string | undefined {
  if (typeof input === "string") {
    return truncate(input, 80);
  }
  if (!isRecord(input)) {
    return undefined;
  }

  const candidates = ["path", "filePath", "query", "q", "url", "command", "text", "prompt", "title", "app"];
  for (const candidate of candidates) {
    const value = input[candidate];
    if (typeof value === "string" && value.trim()) {
      return truncate(value, 80);
    }
  }

  return undefined;
}

function latestErrorToolDetail(transcript: readonly TranscriptMessage[], runStartedAt: string): string | undefined {
  const runStartedAtMs = Date.parse(runStartedAt);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    if (Number.isFinite(runStartedAtMs) && Date.parse(item.createdAt) < runStartedAtMs) {
      break;
    }
    if (item.kind === "tool" && item.status === "error" && item.detail) {
      return item.detail;
    }
  }
  return undefined;
}

function clearerRunFailureLabel(message: string, latestToolError: string | undefined): string {
  if (!latestToolError) {
    return message;
  }
  const normalized = message.trim().toLowerCase();
  if (normalized === "terminated" || normalized === "failed" || normalized === "error" || normalized === "run failed") {
    return latestToolError;
  }
  return message;
}

function stringProperty(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
