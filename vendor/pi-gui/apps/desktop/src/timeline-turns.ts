import type { DisplayTimelineItem, TimelineToolCall, TimelineToolGroup, TranscriptMessage } from "./timeline-types";

const MIN_WORKED_DURATION_MS = 1_000;

/**
 * Insert "Worked for Ns" turn markers between turns, derived purely from real
 * message/tool timestamps. A turn begins at a user message and runs until the
 * next user message; the marker sits right after the prompt (Codex-style) and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second.
 */
export function buildDisplayTimelineItems(transcript: readonly TranscriptMessage[]): readonly DisplayTimelineItem[] {
  // Cardo: consecutive tool calls of one request collapse into a single group row.
  const grouped = groupToolCalls(transcript);
  const result: DisplayTimelineItem[] = [];

  for (let index = 0; index < grouped.length; index += 1) {
    const item = grouped[index];
    if (!item) {
      continue;
    }
    result.push(item);

    if (item.kind !== "message" || item.role !== "user") {
      continue;
    }

    const startMs = Date.parse(item.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    for (let next = index + 1; next < grouped.length; next += 1) {
      const nextItem = grouped[next];
      if (!nextItem) {
        continue;
      }
      if (nextItem.kind === "message" && nextItem.role === "user") {
        break;
      }
      const nextMs = Date.parse(nextItem.createdAt);
      if (!Number.isNaN(nextMs)) {
        endMs = endMs == null ? nextMs : Math.max(endMs, nextMs);
      }
    }

    if (endMs == null) {
      continue;
    }

    const durationMs = endMs - startMs;
    if (durationMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    result.push({ kind: "turn-marker", id: `turn-marker:${item.id}`, durationMs });
  }

  return result;
}

/**
 * Collapse the tool calls of one request (all consecutive tool items in the
 * transcript — every call the model emitted in a single batch) into a single
 * {@link TimelineToolGroup} row so batches don't spam the timeline. A lone tool
 * call stays a plain tool item.
 */
function groupToolCalls(transcript: readonly TranscriptMessage[]): (TranscriptMessage | TimelineToolGroup)[] {
  const grouped: (TranscriptMessage | TimelineToolGroup)[] = [];
  let run: TimelineToolCall[] = [];

  const flush = () => {
    if (run.length === 1) {
      grouped.push(run[0]!);
    } else if (run.length > 1) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const group: TimelineToolGroup = {
        kind: "tool-group",
        id: `tool-group:${first.callId}`,
        items: [...run],
        createdAt: last.createdAt,
      };
      grouped.push(group);
    }
    run = [];
  };

  for (const item of transcript) {
    if (!item) {
      continue;
    }
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flush();
    grouped.push(item);
  }
  flush();

  return grouped;
}
