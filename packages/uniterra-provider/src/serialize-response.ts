/**
 * Serialize harness messages into the OpenAI Responses API (`POST
 * {baseURL}/responses`). The Responses protocol restructures the conversation
 * as `input` items: message items carry `content` arrays, prior assistant tool
 * calls become `function_call` items and their results `function_call_output`
 * items. Assistant reasoning rides a `reasoning` item (plain-text `content`
 * plus `summary`) right before its assistant message — OpenAI requires
 * `summary` on reasoning items and DeepSeek merges `content` into the adjacent
 * assistant message, so both consume the same shape.
 * Core image blocks are rejected because this wire route is text-only.
 *
 * @module @uniterra-solutions/uniterra-provider/serialize-response
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type {
  ResponsesContent,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
} from './types.ts';

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'The uniterra responses adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    );
  }
}

/** Wrap plain text as the protocol's `input_text`/`output_text` content. */
function textContent(text: string, kind: 'input_text' | 'output_text'): ResponsesContent[] {
  return text.length > 0 ? [{ type: kind, text }] : [];
}

/**
 * Serialize the conversation into `input` items. Message roles map directly;
 * assistant tool calls and their matching results become function_call /
 * function_call_output item pairs.
 */
export function serializeInput(messages: Message[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === 'system') {
      input.push({
        role: 'system',
        content: textContent(flattenText(message.content), 'input_text'),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const reasoning = message.content
        .filter((block) => block.type === 'reasoning')
        .map((block) => block.text)
        .join('');
      if (reasoning.length > 0) {
        // Round-trip the previous turn's chain of thought. DeepSeek's
        // Responses API in thinking mode rejects a multi-turn tool-call
        // continuation unless the prior turn's reasoning is replayed as a
        // `reasoning` input item BEFORE its function_call items. `id` is a
        // locally synthesized unique key: the harness does not persist
        // reasoning item ids, and both OpenAI and DeepSeek only need it
        // unique within the request.
        input.push({
          type: 'reasoning',
          id: `reasoning_${String(input.length)}`,
          content: [{ type: 'reasoning_text', text: reasoning }],
          summary: [{ type: 'summary_text', text: reasoning }],
        });
      }
      const toolCalls = message.content.filter((block) => block.type === 'tool-call');
      if (toolCalls.length > 0) {
        // A tool-call turn: emit one function_call item per call; any text on
        // the same turn is dropped (tool-call turns are text-less in the
        // harness vocabulary).
        for (const call of toolCalls) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
      } else {
        input.push({
          role: 'assistant',
          content: textContent(flattenText(message.content), 'output_text'),
        });
      }
      continue;
    }
    // user role: text rides the message; tool results become output items.
    const text = flattenText(message.content);
    const toolResults = message.content.filter((block) => block.type === 'tool-result');
    if (text.length > 0) {
      input.push({ role: 'user', content: textContent(text, 'input_text') });
    }
    for (const result of toolResults) {
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: flattenText(result.content) || '(no output)',
      });
    }
  }
  return input;
}

/**
 * Build the full wire request. Always streaming; optional fields are omitted
 * rather than sent as null, so upstream defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the responses request body.
 */
export function serializeRequest(options: GenerateOptions): ResponsesRequest {
  const input: ResponsesInputItem[] = [];
  if (options.system !== undefined && options.system.length > 0) {
    input.push({ role: 'system', content: textContent(options.system, 'input_text') });
  }
  input.push(...serializeInput(options.messages));

  const tools: ResponsesTool[] | undefined = options.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return {
    model: options.model,
    input,
    stream: true,
    store: false,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
  };
}
