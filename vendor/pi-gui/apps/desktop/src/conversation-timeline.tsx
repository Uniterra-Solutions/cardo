import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefCallback,
  type RefObject,
} from "react";
import type { TranscriptMessage } from "./desktop-state";
import type { DisplayTimelineItem, TimelineThinking, TimelineToolGroup } from "./timeline-types";
import { buildDisplayTimelineItems, pruneExpandState, sameDisplayItemContent } from "./timeline-turns";
import { ThreadSearchBar } from "./thread-search";
import { TimelineItem } from "./timeline-item";
import { SparkIcon } from "./icons";

const OVERSCAN_PX = 720;
const ROW_GAP_PX = 14;
const SCROLL_TO_PADDING_PX = 16;
export const VIRTUALIZATION_THRESHOLD = 80;

interface ThreadSearchModel {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly search: (query: string) => void;
  readonly goToMatch: (direction: 1 | -1) => void;
  readonly close: () => void;
}

interface ConversationTimelineProps {
  readonly transcript: readonly TranscriptMessage[];
  readonly isTranscriptLoading: boolean;
  readonly timelinePaneRef: MutableRefObject<HTMLDivElement | null>;
  readonly timelinePaneElementRef?: RefCallback<HTMLDivElement>;
  readonly disableVirtualization?: boolean;
  readonly onDisableVirtualizationReady?: () => void;
  readonly onTimelineScroll: () => void;
  readonly onTimelineScrollIntent?: () => void;
  readonly threadSearch: ThreadSearchModel;
  readonly showJumpToLatest: boolean;
  readonly onJumpToLatest: () => void;
  readonly onContentHeightChange: (state?: { readonly wasAtBottom: boolean }) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly promptRailVisible?: boolean;
}

export function ConversationTimeline({
  transcript,
  isTranscriptLoading,
  timelinePaneRef,
  timelinePaneElementRef,
  disableVirtualization = false,
  onDisableVirtualizationReady,
  onTimelineScroll,
  onTimelineScrollIntent,
  threadSearch,
  showJumpToLatest,
  onJumpToLatest,
  onContentHeightChange,
  onViewFileInDiff,
  onForkFromMessage,
  promptRailVisible = true,
}: ConversationTimelineProps) {
  const renderedMessageIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let messageIndex = 0;
    for (const item of transcript) {
      if (item.kind !== "message") {
        continue;
      }
      map.set(item.id, messageIndex);
      messageIndex += 1;
    }
    return map;
  }, [transcript]);

  const displayItems = useMemo(() => buildDisplayTimelineItems(transcript), [transcript]);

  // Giant prose blocks and attachment-heavy rows routinely blow past the estimator,
  // so keep those transcripts on the exact DOM path instead of restoring to a fake bottom.
  const hasUnreliableVirtualizedHeights = transcript.some(
    (item) => item.kind === "message" && (item.text.length > 2000 || Boolean(item.attachments?.length)),
  );
  const shouldVirtualize =
    !threadSearch.isOpen &&
    transcript.length > VIRTUALIZATION_THRESHOLD &&
    !disableVirtualization &&
    !hasUnreliableVirtualizedHeights;
  // Cardo: expand sets are pruned by pruneExpandState which returns the input
  // reference when unchanged; readonly typing keeps that bail-out contract honest.
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedToolGroupIds, setExpandedToolGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  // Cardo: reasoning blocks and tool batches are collapsible rows too.
  const [expandedThinkingIds, setExpandedThinkingIds] = useState<ReadonlySet<string>>(() => new Set());
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);

  useLayoutEffect(() => {
    const availableToolCallIds = new Set(
      transcript.filter((item): item is Extract<TranscriptMessage, { kind: "tool" }> => item.kind === "tool").map((item) => item.callId),
    );
    const availableToolGroupIds = new Set(
      displayItems.filter((item): item is TimelineToolGroup => item.kind === "tool-group").map((item) => item.id),
    );
    const availableThinkingIds = new Set(
      transcript.filter((item): item is TimelineThinking => item.kind === "thinking").map((item) => item.id),
    );
    setExpandedToolCallIds((current) => pruneExpandState(current, availableToolCallIds));
    setExpandedToolGroupIds((current) => pruneExpandState(current, availableToolGroupIds));
    setExpandedThinkingIds((current) => pruneExpandState(current, availableThinkingIds));
  }, [displayItems, transcript]);

  useLayoutEffect(() => {
    const knownIds = new Set(transcript.map((item) => item.id));
    let removedAny = false;
    for (const id of measuredHeightsRef.current.keys()) {
      if (knownIds.has(id)) {
        continue;
      }
      measuredHeightsRef.current.delete(id);
      removedAny = true;
    }
    if (removedAny) {
      setMeasurementVersion((current) => current + 1);
    }
  }, [transcript]);

  useLayoutEffect(() => {
    if (!disableVirtualization || isTranscriptLoading || transcript.length === 0) {
      return;
    }
    const allRowsMeasured = transcript.every((item) => measuredHeightsRef.current.has(item.id));
    if (!allRowsMeasured) {
      return;
    }
    onDisableVirtualizationReady?.();
  }, [disableVirtualization, isTranscriptLoading, measurementVersion, onDisableVirtualizationReady, transcript]);

  const toggleToolCall = useCallback((callId: string) => {
    setExpandedToolCallIds((current) => {
      const next = new Set(current);
      if (next.has(callId)) {
        next.delete(callId);
      } else {
        next.add(callId);
      }
      return next;
    });
  }, []);

  const toggleToolGroup = useCallback((groupId: string) => {
    setExpandedToolGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleThinking = useCallback((thinkingId: string) => {
    setExpandedThinkingIds((current) => {
      const next = new Set(current);
      if (next.has(thinkingId)) {
        next.delete(thinkingId);
      } else {
        next.add(thinkingId);
      }
      return next;
    });
  }, []);

  const updateMeasuredHeight = useCallback((id: string, height: number) => {
    const nextHeight = Math.max(1, Math.ceil(height));
    const currentHeight = measuredHeightsRef.current.get(id);
    if (currentHeight === nextHeight) {
      return;
    }
    measuredHeightsRef.current.set(id, nextHeight);
    setMeasurementVersion((current) => current + 1);
  }, []);

  const assignTimelinePaneRef = useCallback((node: HTMLDivElement | null) => {
    timelinePaneRef.current = node;
    timelinePaneElementRef?.(node);
  }, [timelinePaneElementRef, timelinePaneRef]);

  const userPrompts = useMemo<readonly UserPromptEntry[]>(() => {
    const prompts: UserPromptEntry[] = [];
    let turnNumber = 0;
    for (const item of transcript) {
      if (item.kind !== "message" || item.role !== "user") {
        continue;
      }
      turnNumber += 1;
      prompts.push({ id: item.id, turnNumber, preview: buildPromptPreview(item.text) });
    }
    return prompts;
  }, [transcript]);

  const scrollToMessage = useCallback((messageId: string) => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    // Mark this as a deliberate scroll so the bottom-pinning engine treats it as
    // intent and does not snap the view back to the latest activity.
    onTimelineScrollIntent?.();

    const scrollToExisting = (): boolean => {
      const target = pane.querySelector<HTMLElement>(`[data-message-id="${cssEscape(messageId)}"]`);
      if (!target) {
        return false;
      }
      const paneRect = pane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const nextTop = Math.max(0, pane.scrollTop + (targetRect.top - paneRect.top) - SCROLL_TO_PADDING_PX);
      pane.scrollTo({ top: nextTop, behavior: "smooth" });
      return true;
    };

    if (scrollToExisting()) {
      return;
    }

    // Virtualized rows outside the render window are absent from the DOM, so jump
    // to the computed offset first, then let the row mount and fine-tune.
    let offset = 0;
    for (const item of displayItems) {
      if (item.id === messageId) {
        break;
      }
      offset += measuredHeightsRef.current.get(item.id) ?? estimateTimelineItemHeight(item);
      offset += ROW_GAP_PX;
    }
    pane.scrollTop = Math.max(0, offset - SCROLL_TO_PADDING_PX);
    window.requestAnimationFrame(() => {
      scrollToExisting();
    });
  }, [displayItems, onTimelineScrollIntent, timelinePaneRef]);

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return undefined;
    }

    pane.addEventListener("scroll", onTimelineScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", onTimelineScroll);
    };
  }, [onTimelineScroll, timelinePaneRef]);

  return (
    <div className="timeline-surface">
    <div
      className="timeline-pane timeline-pane--thread"
      data-testid="timeline-pane"
      ref={assignTimelinePaneRef}
      onPointerDown={onTimelineScrollIntent}
      onWheel={onTimelineScrollIntent}
    >
      {threadSearch.isOpen ? (
        <ThreadSearchBar
          query={threadSearch.query}
          matchCount={threadSearch.matchCount}
          activeIndex={threadSearch.activeIndex}
          inputRef={threadSearch.inputRef}
          onSearch={threadSearch.search}
          onNext={() => threadSearch.goToMatch(1)}
          onPrev={() => threadSearch.goToMatch(-1)}
          onClose={threadSearch.close}
        />
      ) : null}
      {isTranscriptLoading ? (
        <div className="timeline" data-testid="transcript">
          <TranscriptSkeleton />
        </div>
      ) : transcript.length === 0 ? (
        <div className="timeline" data-testid="transcript">
          <TranscriptEmptyState />
        </div>
      ) : shouldVirtualize ? (
        <VirtualizedTranscriptList
          displayItems={displayItems}
          timelinePaneRef={timelinePaneRef}
          onContentHeightChange={onContentHeightChange}
          measuredHeightsRef={measuredHeightsRef}
          measurementVersion={measurementVersion}
          expandedToolCallIds={expandedToolCallIds}
          expandedToolGroupIds={expandedToolGroupIds}
          expandedThinkingIds={expandedThinkingIds}
          onHeightChange={updateMeasuredHeight}
          onToggleToolCall={toggleToolCall}
          onToggleToolGroup={toggleToolGroup}
          onToggleThinking={toggleThinking}
          onViewFileInDiff={onViewFileInDiff}
          renderedMessageIndexById={renderedMessageIndexById}
          onForkFromMessage={onForkFromMessage}
        />
      ) : (
        <div className="timeline" data-testid="transcript">
          {displayItems.map((item) => (
            <MeasuredTimelineItem
              item={item}
              key={item.id}
              onHeightChange={updateMeasuredHeight}
              expandedToolCallIds={expandedToolCallIds}
              expandedToolGroupIds={expandedToolGroupIds}
              expandedThinkingIds={expandedThinkingIds}
              onToggleToolCall={toggleToolCall}
              onToggleToolGroup={toggleToolGroup}
              onToggleThinking={toggleThinking}
              onViewFileInDiff={onViewFileInDiff}
              sourceMessageIndex={renderedMessageIndexById.get(item.id)}
              onForkFromMessage={onForkFromMessage}
            />
          ))}
        </div>
      )}
      {showJumpToLatest ? (
        <button className="timeline-jump" data-testid="timeline-jump" type="button" onClick={onJumpToLatest}>
          New activity below
        </button>
      ) : null}
    </div>
      {promptRailVisible && !isTranscriptLoading && userPrompts.length > 1 ? (
        <TimelineContextRail prompts={userPrompts} onSelect={scrollToMessage} />
      ) : null}
    </div>
  );
}

interface UserPromptEntry {
  readonly id: string;
  readonly turnNumber: number;
  readonly preview: string;
}

function TimelineContextRail({
  prompts,
  onSelect,
}: {
  readonly prompts: readonly UserPromptEntry[];
  readonly onSelect: (messageId: string) => void;
}) {
  return (
    <nav className="timeline-context-rail" data-testid="timeline-context-rail" aria-label="Prompts in this thread">
      <div className="timeline-context-rail__title">Prompts</div>
      <ol className="timeline-context-rail__list">
        {prompts.map((prompt) => (
          <li key={prompt.id}>
            <button
              type="button"
              className="timeline-context-rail__item"
              data-testid="timeline-context-rail-item"
              title={prompt.preview}
              onClick={() => onSelect(prompt.id)}
            >
              <span className="timeline-context-rail__index">{prompt.turnNumber}</span>
              <span className="timeline-context-rail__text">{prompt.preview}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function buildPromptPreview(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine || "Prompt";
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" data-testid="transcript-skeleton" aria-hidden="true">
      <div className="transcript-skeleton__row transcript-skeleton__row--user">
        <span className="skeleton-line" style={{ width: "42%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "88%" }} />
        <span className="skeleton-line" style={{ width: "94%" }} />
        <span className="skeleton-line" style={{ width: "66%" }} />
      </div>
      <div className="transcript-skeleton__row transcript-skeleton__row--tool">
        <span className="skeleton-line skeleton-line--tool" style={{ width: "38%" }} />
      </div>
      <div className="transcript-skeleton__row">
        <span className="skeleton-line" style={{ width: "80%" }} />
        <span className="skeleton-line" style={{ width: "72%" }} />
      </div>
      <span className="sr-only">Loading transcript…</span>
    </div>
  );
}

function TranscriptEmptyState() {
  return (
    <div className="transcript-empty" data-testid="transcript-empty">
      <span className="transcript-empty__glyph" aria-hidden="true">
        <SparkIcon />
      </span>
      <p className="transcript-empty__title">Start the conversation</p>
      <p className="transcript-empty__hint">Send a prompt below to begin this session.</p>
    </div>
  );
}

function VirtualizedTranscriptList({
  displayItems,
  timelinePaneRef,
  onContentHeightChange,
  measuredHeightsRef,
  measurementVersion,
  expandedToolCallIds,
  expandedToolGroupIds,
  expandedThinkingIds,
  onHeightChange,
  onToggleToolCall,
  onToggleToolGroup,
  onToggleThinking,
  onViewFileInDiff,
  renderedMessageIndexById,
  onForkFromMessage,
}: {
  readonly displayItems: readonly DisplayTimelineItem[];
  readonly timelinePaneRef: MutableRefObject<HTMLDivElement | null>;
  readonly onContentHeightChange: (state?: { readonly wasAtBottom: boolean }) => void;
  readonly measuredHeightsRef: MutableRefObject<Map<string, number>>;
  readonly measurementVersion: number;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly expandedToolGroupIds: ReadonlySet<string>;
  readonly expandedThinkingIds: ReadonlySet<string>;
  readonly onHeightChange: (id: string, height: number) => void;
  readonly onToggleToolCall: (callId: string) => void;
  readonly onToggleToolGroup: (groupId: string) => void;
  readonly onToggleThinking: (thinkingId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly renderedMessageIndexById: ReadonlyMap<string, number>;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
}) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const previousTotalHeightRef = useRef(0);
  void measurementVersion;

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return undefined;
    }

    const syncViewport = () => {
      const nextScrollTop = pane.scrollTop;
      const nextHeight = pane.clientHeight;
      setViewport((current) =>
        current.scrollTop === nextScrollTop && current.height === nextHeight
          ? current
          : { scrollTop: nextScrollTop, height: nextHeight },
      );
    };

    syncViewport();
    pane.addEventListener("scroll", syncViewport, { passive: true });
    const resizeObserver = new ResizeObserver(() => {
      syncViewport();
    });
    resizeObserver.observe(pane);

    return () => {
      pane.removeEventListener("scroll", syncViewport);
      resizeObserver.disconnect();
    };
  }, [timelinePaneRef]);

  const rowHeights = displayItems.map((item) => measuredHeightsRef.current.get(item.id) ?? estimateTimelineItemHeight(item));
  const rowOffsets: number[] = [];
  let totalHeight = 0;
  for (const [index, rowHeight] of rowHeights.entries()) {
    rowOffsets[index] = totalHeight;
    totalHeight += rowHeight;
    if (index < rowHeights.length - 1) {
      totalHeight += ROW_GAP_PX;
    }
  }

  useLayoutEffect(() => {
    const previousTotalHeight = previousTotalHeightRef.current;
    if (previousTotalHeight === totalHeight) {
      return;
    }
    previousTotalHeightRef.current = totalHeight;
    const pane = timelinePaneRef.current;
    const wasAtBottom = previousTotalHeight > 0 && pane
      ? previousTotalHeight - pane.scrollTop - pane.clientHeight < 32
      : false;
    onContentHeightChange({ wasAtBottom });
  }, [onContentHeightChange, totalHeight]);

  const startOffset = Math.max(0, viewport.scrollTop - OVERSCAN_PX);
  const endOffset = viewport.scrollTop + viewport.height + OVERSCAN_PX;
  const startIndex = findStartIndex(rowOffsets, rowHeights, startOffset);
  const endIndex = findEndIndex(rowOffsets, endOffset);

  return (
    <div className="timeline timeline--virtualized" data-testid="transcript" style={{ height: `${totalHeight}px` }}>
      {displayItems.slice(startIndex, endIndex).map((item, offsetIndex) => {
        const index = startIndex + offsetIndex;
        return (
          <MeasuredTimelineItem
            item={item}
            key={item.id}
            className="timeline__virtual-row"
            top={rowOffsets[index] ?? 0}
            onHeightChange={onHeightChange}
            expandedToolCallIds={expandedToolCallIds}
            expandedToolGroupIds={expandedToolGroupIds}
            expandedThinkingIds={expandedThinkingIds}
            onToggleToolCall={onToggleToolCall}
            onToggleToolGroup={onToggleToolGroup}
            onToggleThinking={onToggleThinking}
            onViewFileInDiff={onViewFileInDiff}
            sourceMessageIndex={renderedMessageIndexById.get(item.id)}
            onForkFromMessage={onForkFromMessage}
          />
        );
      })}
    </div>
  );
}

function MeasuredTimelineItemImpl({
  item,
  className,
  top,
  onHeightChange,
  expandedToolCallIds,
  expandedToolGroupIds,
  expandedThinkingIds,
  onToggleToolCall,
  onToggleToolGroup,
  onToggleThinking,
  onViewFileInDiff,
  sourceMessageIndex,
  onForkFromMessage,
}: {
  readonly item: DisplayTimelineItem;
  readonly className?: string;
  readonly top?: number;
  readonly onHeightChange: (id: string, height: number) => void;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly expandedToolGroupIds: ReadonlySet<string>;
  readonly expandedThinkingIds: ReadonlySet<string>;
  readonly onToggleToolCall: (callId: string) => void;
  readonly onToggleToolGroup: (groupId: string) => void;
  readonly onToggleThinking: (thinkingId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      onHeightChange(item.id, element.getBoundingClientRect().height);
    };

    measure();
    const resizeObserver = new ResizeObserver(() => {
      measure();
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [item.id, onHeightChange]);

  return (
    <div
      className={className}
      ref={rowRef}
      data-message-id={item.id}
      style={top == null ? undefined : { transform: `translateY(${top}px)` }}
    >
      <TimelineItem
        item={item}
        expandedToolCallIds={expandedToolCallIds}
        expandedToolGroupIds={expandedToolGroupIds}
        expandedThinkingIds={expandedThinkingIds}
        onToggleToolCall={onToggleToolCall}
        onToggleToolGroup={onToggleToolGroup}
        onToggleThinking={onToggleThinking}
        onViewFileInDiff={onViewFileInDiff}
        sourceMessageIndex={sourceMessageIndex}
        onForkFromMessage={onForkFromMessage}
      />
    </div>
  );
}

// Cardo: the main process streams transcript snapshots (~1 per
// STREAM_PUBLISH_INTERVAL_MS) — full on session switch, incremental deltas
// afterwards (see src/transcript-delta.ts). Without memoization every snapshot
// re-renders and re-parses markdown/syntax for every row, so the UI falls
// behind the backend on long tasks (agent finishes, UI still replaying).
// Rows are memoized by content: the delta protocol keeps untouched items
// reference-stable in the renderer, so the reference check below short-circuits
// for every unchanged row (O(1)) and only the changed assistant/thinking/tool
// rows fall through to a deep content comparison. The other props (expanded
// sets, callbacks) are referentially stable across snapshots, so identity
// checks keep the comparator cheap.
const MeasuredTimelineItem = memo(MeasuredTimelineItemImpl, (prev, next) => {
  if (
    prev.sourceMessageIndex !== next.sourceMessageIndex ||
    prev.top !== next.top ||
    prev.expandedToolCallIds !== next.expandedToolCallIds ||
    prev.expandedToolGroupIds !== next.expandedToolGroupIds ||
    prev.expandedThinkingIds !== next.expandedThinkingIds ||
    prev.onHeightChange !== next.onHeightChange ||
    prev.onToggleToolCall !== next.onToggleToolCall ||
    prev.onToggleToolGroup !== next.onToggleToolGroup ||
    prev.onToggleThinking !== next.onToggleThinking ||
    prev.onViewFileInDiff !== next.onViewFileInDiff ||
    prev.onForkFromMessage !== next.onForkFromMessage
  ) {
    return false;
  }
  return sameDisplayItemContent(prev.item, next.item);
});

function findStartIndex(offsets: readonly number[], heights: readonly number[], targetOffset: number): number {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const end = (offsets[mid] ?? 0) + (heights[mid] ?? 0);
    if (end < targetOffset) {
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  return Math.max(0, Math.min(offsets.length - 1, low));
}

function findEndIndex(offsets: readonly number[], targetOffset: number): number {
  if (offsets.length === 0) {
    return 0;
  }

  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid] ?? 0) <= targetOffset) {
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  const lastVisibleIndex = Math.max(0, low);
  return Math.min(offsets.length, Math.max(lastVisibleIndex + 1, 1));
}

function estimateTimelineItemHeight(item: DisplayTimelineItem): number {
  if (item.kind === "turn-marker") {
    return 32;
  }
  if (item.kind === "message") {
    const attachmentHeight = item.attachments?.some((attachment) => attachment.kind === "image")
      ? 120
      : item.attachments?.length
        ? 56
        : 0;
    const textLength = Math.max(item.text.length, 1);
    return 48 + attachmentHeight + Math.min(240, Math.ceil(textLength / 90) * 20);
  }
  if (item.kind === "tool") {
    return 52;
  }
  if (item.kind === "tool-group") {
    return 40;
  }
  if (item.kind === "thinking") {
    return item.endedAt != null ? 36 : 120;
  }
  if (item.kind === "summary") {
    return item.presentation === "divider" ? 44 : 38;
  }
  return 38;
}
