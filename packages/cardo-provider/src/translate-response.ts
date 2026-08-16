/**
 * Translate Responses API SSE events into harness StreamChunks. Unlike Chat
 * Completions, the Responses protocol has no `[DONE]` sentinel: the stream
 * ends with a `response.completed` / `response.incomplete` / `response.failed`
 * event carrying the terminal status. Each event carries an `event` type and a
 * `sequence_number`; the harness cares only about the type field.
 *
 * Event → block mapping:
 *  - `response.output_text.delta` → text delta
 *  - `response.reasoning_text.delta` → reasoning delta (when the gateway emits it)
 *  - `response.function_call_arguments.delta` → tool-call delta (item id = call id)
 *  - `response.completed` → usage + finish; emits no further deltas
 *  - `response.failed` / `response.incomplete` → error finish
 *
 * @module @cardo/cardo-provider/translate-response
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { ResponsesEvent } from './types.ts';

/** One open block under assembly. */
interface OpenBlock {
  index: number;
  kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  /** tool-call only */
  callId?: string;
  name?: string;
}

/** Map the terminal status of a completed response into a finish reason. */
function terminalReason(status: string): FinishReason {
  switch (status) {
    case 'completed':
      return { kind: 'stop' };
    case 'incomplete':
      return {
        kind: 'error',
        failure: { message: 'response incomplete', code: 'INCOMPLETE' },
      };
    default:
      return {
        kind: 'error',
        failure: { message: `response ${status}`, code: status.toUpperCase() },
      };
  }
}

/** Map Responses usage fields to disjoint harness counts. */
function mapUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}): TokenUsage {
  const cacheRead = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens - (cacheRead ?? 0),
    outputTokens: usage.output_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Consume Responses SSE event objects and yield StreamChunks. Deltas stream as
 * they arrive; `block-end`s and usage/finish are deferred to the terminal event.
 * @param events - parsed SSE data payloads (JSON event objects, no `[DONE]`).
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` emitted once at the terminal event.
 */
export async function* translate(events: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let textBlock: OpenBlock | undefined;
  let reasoningBlock: OpenBlock | undefined;
  const toolBlocks = new Map<string, OpenBlock>();
  const order: OpenBlock[] = [];
  let pendingUsage: TokenUsage | undefined;
  let terminal: FinishReason | undefined;
  const callNames = new Map<string, string>();

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' };
    order.push(block);
    return block;
  }

  function closeBlocks(): ContentBlock[] {
    return order.map((block) => {
      switch (block.kind) {
        case 'text':
          return { type: 'text' as const, text: block.text };
        case 'reasoning':
          return { type: 'reasoning' as const, text: block.text };
        case 'tool-call':
          return {
            type: 'tool-call' as const,
            id: CallId(block.callId ?? ''),
            name: block.name ?? '',
            arguments: block.text,
          };
      }
    });
  }

  for await (const payload of events) {
    if (payload.trim().length === 0) continue;
    let event: ResponsesEvent;
    try {
      event = JSON.parse(payload) as ResponsesEvent;
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }

    switch (event.type) {
      case 'response.output_text.delta': {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += event.delta;
        yield { type: 'text-delta', index: textBlock.index, text: event.delta };
        break;
      }
      case 'response.reasoning_text.delta': {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += event.delta;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.delta };
        break;
      }
      case 'response.function_call_arguments.delta': {
        const callId = event.item_id;
        let block = toolBlocks.get(callId);
        if (!block) {
          block = open('tool-call');
          block.callId = callId;
          toolBlocks.set(callId, block);
          const name = callNames.get(callId);
          if (name !== undefined) block.name = name;
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        block.text += event.delta;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(callId),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: event.delta,
        };
        break;
      }
      case 'response.function_call_arguments.done': {
        const block = toolBlocks.get(event.item_id);
        if (block) block.text = event.arguments;
        break;
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = event.item;
        if (item.type === 'function_call') {
          callNames.set(item.id, item.name);
          // The item may arrive fully-formed (no deltas): materialize a block.
          if (item.arguments && !toolBlocks.has(item.id)) {
            const block = open('tool-call');
            block.callId = item.id;
            block.name = item.name;
            block.text = item.arguments;
            toolBlocks.set(item.id, block);
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
          }
        }
        break;
      }
      case 'response.completed': {
        if (event.response.usage) pendingUsage = mapUsage(event.response.usage);
        terminal = terminalReason('completed');
        break;
      }
      case 'response.incomplete': {
        terminal = terminalReason('incomplete');
        break;
      }
      case 'response.failed': {
        const message = event.response.error?.message ?? 'response failed';
        terminal = {
          kind: 'error',
          failure: { message, code: event.response.error?.code ?? 'PROVIDER_ERROR' },
        };
        break;
      }
      case 'response.created':
      case 'response.in_progress':
      case 'response.content_part.added':
      case 'response.output_text.done':
      case 'response.reasoning_text.done':
        // Lifecycle and content-frame bookkeeping events carry no harness
        // deltas of their own.
        break;
    }
  }

  // Emit all assembled blocks, then usage and finish.
  const blocks = closeBlocks();
  for (const [at, block] of order.entries()) {
    const closed = blocks[at];
    if (closed === undefined) continue;
    yield { type: 'block-end', index: block.index, block: closed };
  }
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
  const reason = terminal ?? { kind: 'stop' as const };
  yield {
    type: 'finish',
    reason:
      reason.kind === 'stop' && order.length === 0
        ? {
            kind: 'error',
            failure: {
              message: 'model returned a completed response with no content',
              code: EMPTY_RESPONSE_CODE,
            },
          }
        : reason,
  };
}
