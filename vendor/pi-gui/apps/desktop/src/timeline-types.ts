import type { SessionTranscriptMessage, SessionTranscriptRole } from "@pi-gui/pi-sdk-driver";

export type SessionRole = SessionTranscriptRole;
export type TimelineTone = "neutral" | "success" | "warning" | "error";
export type TimelineToolStatus = "running" | "success" | "error";
export type TimelineSummaryPresentation = "inline" | "divider";

export interface TimelineActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly tone?: TimelineTone;
}

export interface TimelineToolCall {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly status: TimelineToolStatus;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly createdAt: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

// Cardo: reasoning/thinking block produced by the model ahead of an assistant message.
// While streaming (live events) `endedAt` is undefined so the UI shows the text;
// once finalized the block collapses to a "Thought for Ns" row. Persisted
// thinking recovered from the session file carries `endedAt` set to its
// `createdAt` so it always renders collapsed.
export interface TimelineThinking {
  readonly kind: "thinking";
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface TimelineSummary {
  readonly kind: "summary";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly metadata?: string;
  readonly presentation: TimelineSummaryPresentation;
}

export type TranscriptMessage = SessionTranscriptMessage | TimelineActivity | TimelineToolCall | TimelineThinking | TimelineSummary;

/**
 * A derived, view-only marker inserted between turns to show how long the agent
 * worked on the preceding user prompt. Never persisted or produced by the store;
 * the timeline computes it from real message/tool timestamps at render time, so
 * it is kept out of {@link TranscriptMessage} to avoid leaking into store code.
 */
export interface TimelineTurnMarker {
  readonly kind: "turn-marker";
  readonly id: string;
  readonly durationMs: number;
}

// Cardo: a derived, view-only wrapper that groups the tool calls of one request (all
// tool calls the model emitted in a single batch) into a single collapsible row.
// Built at render time by the timeline, never persisted.
export interface TimelineToolGroup {
  readonly kind: "tool-group";
  readonly id: string;
  readonly items: readonly TimelineToolCall[];
  readonly createdAt: string;
}

export type DisplayTimelineItem = TranscriptMessage | TimelineTurnMarker | TimelineToolGroup;
