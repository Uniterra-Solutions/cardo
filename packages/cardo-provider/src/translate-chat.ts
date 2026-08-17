/**
 * Translate Chat Completions SSE payloads into harness StreamChunks. One
 * stateful harness block per content, reasoning, or tool-call index. An empty
 * initial reasoning delta does not open a block. Finish reason and the latest
 * usage are deferred until `[DONE]`, covering both finish-attached and
 * trailing usage-only shapes while ensuring no chunk follows `finish`.
 *
 * Reasoning arrives under three wire shapes, all preserved: `delta.
 * reasoning_content` (DeepSeek/Qwen/GLM style), `delta.reasoning`
 * (OpenRouter/aggregator style), and a full-text `message.reasoning_content` /
 * `message.reasoning` replay on the terminal chunk (DashScope compatible
 * mode). Buffered gateways replay `message.content` / `message.tool_calls` the
 * same way; every replay is appended only when nothing of that kind streamed,
 * so nothing is lost and nothing is duplicated.
 *
 * @module @cardo/cardo-provider/translate-chat
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { DONE } from './sse.ts';
import type { ChatChunk, ChatToolCallDelta, ChatUsage } from './types.ts';

/** One open block under assembly. */
interface OpenBlock {
  index: number;
  kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  /** tool-call only */
  callId?: string;
  name?: string;
}

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' };
    case 'tool_calls':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      };
  }
}

/**
 * Map wire usage fields. `prompt_tokens` INCLUDES cache hits; the harness
 * TokenUsage convention is DISJOINT counts, so cache reads are subtracted out
 * of `inputTokens`.
 */
export function mapUsage(usage: ChatUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'reasoning':
      return { type: 'reasoning', text: block.text };
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId ?? ''),
        name: block.name ?? '',
        arguments: block.text,
      };
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 *
 * Reasoning arrives under three wire shapes, all preserved: `delta.
 * reasoning_content` (DeepSeek/Qwen/GLM style), `delta.reasoning`
 * (OpenRouter/aggregator style), and a full-text `message.reasoning_content` /
 * `message.reasoning` replay on the terminal chunk (DashScope compatible
 * mode) — the replay is appended only when no reasoning deltas streamed, so
 * nothing is lost and nothing is duplicated.
 *
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let textBlock: OpenBlock | undefined;
  let reasoningBlock: OpenBlock | undefined;
  const toolBlocks = new Map<number, OpenBlock>();
  const order: OpenBlock[] = [];
  let pendingFinish: FinishReason | undefined;
  let pendingUsage: TokenUsage | undefined;
  let sawDeltaReasoning = false;
  let sawDeltaText = false;
  const replayReasoning: string[] = [];
  const replayText: string[] = [];
  const replayToolCalls: ChatToolCallDelta[] = [];

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' };
    order.push(block);
    return block;
  }

  /**
   * Append one non-empty reasoning fragment to the reasoning block, opening
   * it first. `front` presents a whole-response replay before the answer
   * block it trails.
   */
  function pushReasoning(fragment: string, front = false): StreamChunk[] {
    if (typeof fragment !== 'string' || fragment.length === 0) return [];
    const chunks: StreamChunk[] = [];
    if (!reasoningBlock) {
      reasoningBlock = open('reasoning');
      if (front) {
        order.pop();
        order.unshift(reasoningBlock);
      }
      chunks.push({ type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' });
    }
    reasoningBlock.text += fragment;
    chunks.push({ type: 'reasoning-delta', index: reasoningBlock.index, text: fragment });
    return chunks;
  }

  /** Append one non-empty answer-text fragment, opening the block first. */
  function pushText(fragment: string): StreamChunk[] {
    if (typeof fragment !== 'string' || fragment.length === 0) return [];
    const chunks: StreamChunk[] = [];
    if (!textBlock) {
      textBlock = open('text');
      chunks.push({ type: 'block-start', index: textBlock.index, blockType: 'text' });
    }
    textBlock.text += fragment;
    chunks.push({ type: 'text-delta', index: textBlock.index, text: fragment });
    return chunks;
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      // Buffered gateways replay whole content on the terminal chunk's
      // `message` with empty deltas; append each replay only when nothing of
      // that kind streamed, so nothing is lost and nothing is duplicated.
      if (!sawDeltaReasoning) {
        for (const fragment of replayReasoning) {
          yield* pushReasoning(fragment, true);
        }
      }
      if (!sawDeltaText) {
        for (const fragment of replayText) {
          yield* pushText(fragment);
        }
      }
      for (const call of replayToolCalls) {
        const existing = toolBlocks.get(call.index);
        if (existing !== undefined) continue;
        const block = open('tool-call');
        block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        block.text = call.function?.arguments ?? '';
        toolBlocks.set(call.index, block);
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: block.text,
        };
      }
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
      const reason = pendingFinish ?? { kind: 'stop' as const };
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
      return;
    }

    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;

      // Reasoning first: reasoning-capable upstreams interleave it before
      // text, under either field name.
      for (const fragment of [delta?.reasoning_content, delta?.reasoning]) {
        if (typeof fragment === 'string' && fragment.length > 0) {
          sawDeltaReasoning = true;
          yield* pushReasoning(fragment);
        }
      }

      const content = delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        sawDeltaText = true;
        yield* pushText(content);
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open('tool-call');
          toolBlocks.set(call.index, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        if (call.id !== undefined) block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        const fragment = call.function?.arguments ?? '';
        block.text += fragment;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }

      // The terminal chunk may replay whole content on `message` instead of
      // streaming deltas; collect it and defer the decision to [DONE].
      const message = choice.message;
      const replayReasoningFragment = firstNonEmpty(message?.reasoning_content, message?.reasoning);
      if (replayReasoningFragment !== undefined) replayReasoning.push(replayReasoningFragment);
      if (typeof message?.content === 'string' && message.content.length > 0) {
        replayText.push(message.content);
      }
      replayToolCalls.push(...(message?.tool_calls ?? []));

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }

  // parseSse guarantees the [DONE] sentinel (or returns early); reaching here
  // means the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
}

/** The first non-empty string among the candidates, if any. */
function firstNonEmpty(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
