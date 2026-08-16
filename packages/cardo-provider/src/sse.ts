/**
 * Decode an SSE byte stream into event data payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment and non-data field skipping,
 * multi-`data:` joining — is `eventsource-parser`'s. The `[DONE]` sentinel
 * belongs to the Chat Completions protocol; the Responses API instead sends
 * `response.completed` / `response.failed` as ordinary events. This module
 * stays protocol-neutral: it yields every data payload (including `[DONE]` if
 * present) and lets the caller own final flushing.
 *
 * @module @cardo/cardo-provider/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';

/** The terminal payload the Chat Completions protocol sends after the last chunk. */
export const DONE = '[DONE]';

/**
 * Parse an SSE byte stream into data payloads. This parser is protocol-agnostic:
 * it yields each event's data in arrival order and lets the caller decide what
 * a well-formed end looks like (the Chat Completions protocol requires the
 * `[DONE]` sentinel; the Responses API ends with a terminal event object).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }));
  const reader = events.getReader();
  try {
    // The loop only exits through the reader's own `done`; `for(;;)` is the
    // lint-clean spelling of an intentional infinite loop.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value.data;
      if (value.data === DONE) return;
    }
  } finally {
    reader.releaseLock();
  }
}
