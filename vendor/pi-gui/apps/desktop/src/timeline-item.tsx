import { useLayoutEffect, useRef } from "react";
import type { SessionTranscriptMessage } from "@pi-gui/pi-sdk-driver";
import type {
  DisplayTimelineItem,
  TimelineActivity,
  TimelineThinking,
  TimelineToolCall,
  TimelineToolGroup,
  TimelineSummary,
  TimelineTurnMarker,
} from "./timeline-types";
import { MessageMarkdown } from "./message-markdown";
import { InlineDiff, extractDiffFromOutput } from "./diff-inline";
import { ChevronRightIcon, CopyIcon, DiffIcon, FileIcon, ForkIcon, SparkIcon, TerminalIcon } from "./icons";
import { extensionToLanguage } from "./syntax-highlight";

export function TimelineItem({
  item,
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
  readonly expandedToolCallIds?: ReadonlySet<string>;
  readonly expandedToolGroupIds?: ReadonlySet<string>;
  readonly expandedThinkingIds?: ReadonlySet<string>;
  readonly onToggleToolCall?: (callId: string) => void;
  readonly onToggleToolGroup?: (groupId: string) => void;
  readonly onToggleThinking?: (thinkingId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
}) {
  switch (item.kind) {
    case "turn-marker":
      return <TimelineTurnMarkerItem item={item} />;
    case "message":
      return (
        <TimelineMessage
          item={item}
          sourceMessageIndex={sourceMessageIndex}
          onForkFromMessage={onForkFromMessage}
        />
      );
    case "activity":
      return <TimelineActivityItem item={item} />;
    case "tool":
      return (
        <TimelineToolCallItem
          item={item}
          expanded={expandedToolCallIds?.has(item.callId) ?? false}
          onToggle={onToggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
        />
      );
    case "tool-group":
      return (
        <TimelineToolGroupItem
          item={item}
          expanded={expandedToolGroupIds?.has(item.id) ?? false}
          onToggle={onToggleToolGroup}
          expandedToolCallIds={expandedToolCallIds}
          onToggleToolCall={onToggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
        />
      );
    case "thinking":
      return (
        <TimelineThinkingItem
          item={item}
          expanded={expandedThinkingIds?.has(item.id) ?? false}
          onToggle={onToggleThinking}
        />
      );
    case "summary":
      return <TimelineSummaryItem item={item} />;
    default:
      return null;
  }
}

function TimelineMessage({
  item,
  sourceMessageIndex,
  onForkFromMessage,
}: {
  readonly item: SessionTranscriptMessage;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
}) {
  if (item.role === "user") {
    return (
      <article className="timeline-item timeline-item--user">
        <div className="timeline-item__bubble">
          {item.attachments?.length ? (
            <div className="timeline-item__attachments">
              {item.attachments.map((attachment, index) =>
                attachment.kind === "image" ? (
                  <img
                    alt={attachment.name ?? `Attachment ${index + 1}`}
                    className="timeline-item__attachment timeline-item__attachment--image"
                    key={`${item.id}:${index}`}
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  />
                ) : (
                  <div
                    className="timeline-item__attachment timeline-item__attachment--file"
                    key={`${item.id}:${index}`}
                    title={attachment.fsPath}
                  >
                    <span className="timeline-item__attachment-icon" aria-hidden="true">
                      <FileIcon />
                    </span>
                    <span className="timeline-item__attachment-name">{attachment.name}</span>
                  </div>
                ),
              )}
            </div>
          ) : null}
          <MessageMarkdown text={item.text} />
        </div>
      </article>
    );
  }

  if (item.role === "branchSummary" || item.role === "compactionSummary") {
    return (
      <article className="timeline-item timeline-item--summary-card">
        <div className="timeline-item__summary-eyebrow">
          {item.role === "branchSummary" ? "Branch summary" : "Compaction summary"}
        </div>
        <MessageMarkdown text={item.text} />
      </article>
    );
  }

  const canFork = onForkFromMessage != null && sourceMessageIndex !== undefined;
  return (
    <article className="timeline-item timeline-item--assistant">
      <MessageMarkdown text={item.text} />
      {canFork ? (
        <div className="timeline-item__actions">
          <button
            type="button"
            className="timeline-item__action"
            title="Fork conversation from this point"
            aria-label="Fork conversation from this point"
            data-testid="fork-from-message"
            onClick={() => onForkFromMessage(sourceMessageIndex, item.text)}
          >
            <ForkIcon />
            <span className="timeline-item__action-label">Fork</span>
          </button>
        </div>
      ) : null}
    </article>
  );
}

function TimelineActivityItem({ item }: { readonly item: TimelineActivity }) {
  return (
    <div className={`timeline-activity timeline-activity--${item.tone ?? "neutral"}`}>
      <span className="timeline-activity__label">{item.label}</span>
      {item.detail ? <span className="timeline-activity__detail">{item.detail}</span> : null}
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}

function TimelineToolCallItem({
  item,
  expanded,
  onToggle,
  onViewFileInDiff,
}: {
  readonly item: TimelineToolCall;
  readonly expanded: boolean;
  readonly onToggle?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
}) {
  const hasContent = item.input !== undefined || item.output !== undefined;
  const diffText = isWriteTool(item.toolName) ? extractDiffFromOutput(item.output) : undefined;
  const diffStats = diffText ? countDiffStats(diffText) : undefined;
  const compactLabel = buildCompactLabel(item, diffStats);
  const filePath = isWriteTool(item.toolName) ? extractFilename(item.input) || undefined : undefined;
  const diffLanguage = diffText && filePath ? extensionToLanguage(filePath) : undefined;
  const inlineDetail = item.status === "error" ? item.detail : undefined;

  const handleCopy = () => {
    const text = diffText ?? formatToolContent(item.input, item.output);
    void navigator.clipboard.writeText(text);
  };

  return (
    <article className={`timeline-tool timeline-tool--${item.status}`}>
      <div className="timeline-tool__header-row">
        <span className="timeline-tool__glyph" aria-hidden="true">
          {toolGlyph(item.toolName)}
        </span>
        <button
          className="timeline-tool__header"
          type="button"
          aria-expanded={expanded}
          disabled={!hasContent}
          onClick={() => onToggle?.(item.callId)}
        >
          {hasContent ? (
            <span className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}>
              <ChevronRightIcon />
            </span>
          ) : null}
          <span className="timeline-tool__label">{compactLabel}</span>
          {inlineDetail ? <span className="timeline-tool__detail">{inlineDetail}</span> : null}
          {diffStats ? (
            <span className="timeline-tool__diff-stats">
              <span className="timeline-tool__stat-add">+{diffStats.added}</span>
              {" "}
              <span className="timeline-tool__stat-del">-{diffStats.removed}</span>
            </span>
          ) : null}
          <span className="timeline-tool__meta-inline">
            <span className="timeline-tool__status-pip" aria-hidden="true" />
            {`${item.toolName} \u00b7 ${statusLabel(item.status)}`}
          </span>
        </button>
        {filePath && onViewFileInDiff ? (
          <button
            aria-label={`View ${filePath} in changes`}
            className="icon-button timeline-tool__view-in-diff"
            data-testid="timeline-tool-view-in-diff"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onViewFileInDiff(filePath);
            }}
          >
            <DiffIcon />
          </button>
        ) : null}
      </div>
      {expanded && hasContent ? (
        <div className="timeline-tool__body">
          {diffText ? (
            <>
              <div className="timeline-tool__diff-header">
                <span className="timeline-tool__diff-filename">
                  {extractFilename(item.input)}
                  {diffStats ? (
                    <span className="timeline-tool__diff-stats">
                      {" "}<span className="timeline-tool__stat-add">+{diffStats.added}</span>
                      {" "}<span className="timeline-tool__stat-del">-{diffStats.removed}</span>
                    </span>
                  ) : null}
                </span>
                <button className="icon-button timeline-tool__copy" type="button" onClick={handleCopy} aria-label="Copy">
                  <CopyIcon />
                </button>
              </div>
              <InlineDiff diff={diffText} language={diffLanguage} />
            </>
          ) : (
            <>
              <div className="timeline-tool__body-actions">
                <button className="icon-button timeline-tool__copy" type="button" onClick={handleCopy} aria-label="Copy">
                  <CopyIcon />
                </button>
              </div>
              <pre className="timeline-tool__pre">{formatToolContent(item.input, item.output)}</pre>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function isWriteTool(toolName: string): boolean {
  return /write|edit|patch|apply/i.test(toolName);
}

/* ---- Reasoning blocks --------------------------------------------------- */

// Cardo: streaming reasoning block. While the model is still thinking the text is
// shown live; once finalized (`endedAt` set) the block collapses to a
// "Thought for Ns" row that expands on click.
function TimelineThinkingItem({
  item,
  expanded,
  onToggle,
}: {
  readonly item: TimelineThinking;
  readonly expanded: boolean;
  readonly onToggle?: (thinkingId: string) => void;
}) {
  const finalized = item.endedAt != null;
  const showBody = finalized ? expanded : true;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Cardo: the body is a fixed-height window over the streaming text, so every
  // new chunk pins the scroll to the bottom — the newest content is always in
  // view while the model is still thinking.
  useLayoutEffect(() => {
    if (finalized) {
      return;
    }
    const body = bodyRef.current;
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }, [item.text, finalized]);

  return (
    <article className={`timeline-thinking${finalized ? " timeline-thinking--finalized" : ""}`}>
      <button
        className="timeline-thinking__header"
        type="button"
        aria-expanded={showBody}
        disabled={!finalized}
        onClick={() => onToggle?.(item.id)}
      >
        <span className={`timeline-tool__chevron ${showBody ? "timeline-tool__chevron--expanded" : ""}`} aria-hidden="true">
          {finalized ? <ChevronRightIcon /> : null}
        </span>
        <span className="timeline-thinking__glyph" aria-hidden="true">
          <SparkIcon />
        </span>
        <span className="timeline-thinking__label">{finalized ? thinkingLabel(item) : "Thinking…"}</span>
        {!finalized ? (
          <span className="timeline-tool__meta-inline">
            <span className="timeline-tool__status-pip" aria-hidden="true" />
            thinking
          </span>
        ) : null}
      </button>
      {showBody ? (
        <div className="timeline-thinking__body" ref={bodyRef}>
          <pre className="timeline-thinking__pre">{item.text}</pre>
        </div>
      ) : null}
    </article>
  );
}

function thinkingLabel(item: TimelineThinking): string {
  if (item.startedAt && item.endedAt) {
    const durationMs = Date.parse(item.endedAt) - Date.parse(item.startedAt);
    if (!Number.isNaN(durationMs) && durationMs >= 1_000) {
      return `Thought for ${formatWorkedDuration(durationMs)}`;
    }
  }
  return "Thought";
}

/* ---- Cardo: tool batches ------------------------------------------------ */

/**
 * Collapsible row for the tool calls of one request (one batch). Expanded
 * automatically while any call is still running so progress stays visible;
 * once every call settles it collapses to "Used N tools" unless the user
 * opened it explicitly.
 */
function TimelineToolGroupItem({
  item,
  expanded,
  onToggle,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
}: {
  readonly item: TimelineToolGroup;
  readonly expanded: boolean;
  readonly onToggle?: (groupId: string) => void;
  readonly expandedToolCallIds?: ReadonlySet<string>;
  readonly onToggleToolCall?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
}) {
  const count = item.items.length;
  const hasRunning = item.items.some((tool) => tool.status === "running");
  const hasError = item.items.some((tool) => tool.status === "error");
  const showBody = hasRunning || expanded;

  return (
    <article
      className={[
        "timeline-tool-group",
        hasRunning ? "timeline-tool-group--running" : "",
        hasError ? "timeline-tool-group--error" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="timeline-tool-group__header-row">
        <button
          className="timeline-tool-group__header"
          type="button"
          aria-expanded={showBody}
          onClick={() => onToggle?.(item.id)}
        >
          <span className={`timeline-tool__chevron ${showBody ? "timeline-tool__chevron--expanded" : ""}`} aria-hidden="true">
            <ChevronRightIcon />
          </span>
          <span className="timeline-tool-group__glyph" aria-hidden="true">
            <SparkIcon />
          </span>
          <span className="timeline-tool-group__label">{`Used ${count} ${count === 1 ? "tool" : "tools"}`}</span>
          <span className="timeline-tool__meta-inline">
            <span className="timeline-tool__status-pip" aria-hidden="true" />
            {hasRunning ? `${count} running` : "done"}
          </span>
        </button>
      </div>
      {showBody ? (
        <div className="timeline-tool-group__body">
          {item.items.map((tool) => (
            <TimelineToolCallItem
              item={tool}
              key={tool.callId}
              expanded={expandedToolCallIds?.has(tool.callId) ?? false}
              onToggle={onToggleToolCall}
              onViewFileInDiff={onViewFileInDiff}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function toolGlyph(toolName: string) {
  if (isWriteTool(toolName)) {
    return <DiffIcon />;
  }
  if (/bash|shell|exec|terminal|command|run/i.test(toolName)) {
    return <TerminalIcon />;
  }
  if (/read|view|cat|open|file|glob|grep|search|ls/i.test(toolName)) {
    return <FileIcon />;
  }
  return <SparkIcon />;
}

function buildCompactLabel(item: TimelineToolCall, diffStats: { added: number; removed: number } | undefined): string {
  if (isWriteTool(item.toolName)) {
    const filename = extractFilename(item.input);
    if (filename) {
      return `Edited ${shortenPath(filename)}`;
    }
  }
  return item.label;
}

function extractFilename(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const path = record.file_path ?? record.filePath ?? record.path ?? record.filename;
    if (typeof path === "string") {
      return path;
    }
  }
  return "";
}

function shortenPath(filePath: string): string {
  // Show last 2-3 path segments for readability
  const parts = filePath.split("/");
  if (parts.length <= 3) {
    return filePath;
  }
  return parts.slice(-3).join("/");
}

function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatToolContent(input: unknown, output: unknown): string {
  const parts: string[] = [];
  if (input !== undefined) {
    parts.push(typeof input === "string" ? input : JSON.stringify(input, null, 2));
  }
  if (output !== undefined) {
    parts.push(typeof output === "string" ? output : JSON.stringify(output, null, 2));
  }
  return parts.join("\n\n");
}

function statusLabel(status: "running" | "success" | "error") {
  if (status === "running") return "running";
  if (status === "success") return "done";
  return "failed";
}

function TimelineTurnMarkerItem({ item }: { readonly item: TimelineTurnMarker }) {
  return (
    <div className="timeline-turn-marker" data-testid="timeline-turn-marker">
      <span className="timeline-turn-marker__label">{`Worked for ${formatWorkedDuration(item.durationMs)}`}</span>
    </div>
  );
}

function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function TimelineSummaryItem({ item }: { readonly item: TimelineSummary }) {
  if (item.presentation === "divider") {
    return (
      <div className="timeline-summary">
        <span>{item.label}</span>
        {item.metadata ? <span className="timeline-summary__meta">{item.metadata}</span> : null}
      </div>
    );
  }

  return (
    <div className="timeline-activity timeline-activity--summary">
      <span className="timeline-activity__label">{item.label}</span>
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}
