/**
 * Serialize harness messages into OpenAI Chat Completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool results become separate tool messages. Assistant reasoning is
 * replayed as `reasoning_content` — DeepSeek's thinking mode is all-or-nothing:
 * once any assistant message carries reasoning, every later tool-call message
 * must carry the field too, so a turn whose model answer had no reasoning
 * round-trips as the empty marker (other OpenAI-compatible upstreams ignore
 * the field). Core image blocks are rejected explicitly because this wire
 * route is text-only; unknown declaration-merged block types retain the
 * adapter's documented extension fallback.
 *
 * @module @uniterra-solutions/uniterra-provider/serialize-chat
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { ChatMessage, ChatRequest, ChatTool } from './types.ts';

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
      'The uniterra chat-completions adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    );
  }
}

/**
 * Serialize one assistant message (text + reasoning + tool calls).
 * @param message - the harness assistant message.
 * @param sawReasoning - whether any earlier assistant message carried reasoning.
 */
function serializeAssistant(message: Message, sawReasoning: boolean): ChatMessage {
  const text = flattenText(message.content);
  const reasoningBlocks = message.content.filter((block) => block.type === 'reasoning');
  const reasoning = reasoningBlocks.map((block) => block.text).join('');
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }));

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: some
    // gateways reject null outright.
    content: text,
    // Thinking mode is all-or-nothing: replay the turn's own reasoning
    // verbatim (even empty), and once reasoning appeared anywhere in the
    // conversation, later tool-call turns must carry the field too — the
    // model's reasoningless turns round-trip as "" (DeepSeek accepts the
    // empty marker; other gateways ignore the field).
    ...(reasoningBlocks.length > 0 || (toolCalls.length > 0 && sawReasoning)
      ? { reasoning_content: reasoning }
      : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 */
export function serializeMessages(messages: Message[]): ChatMessage[] {
  const wire: ChatMessage[] = [];
  let sawReasoning = false;
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message, sawReasoning));
      if (message.content.some((block) => block.type === 'reasoning')) sawReasoning = true;
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result');
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text });
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      });
    }
  }
  return wire;
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * upstream defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the chat-completions request body.
 */
export function serializeRequest(options: GenerateOptions): ChatRequest {
  const messages: ChatMessage[] = [];
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system });
  }
  messages.push(...serializeMessages(options.messages));

  const tools: ChatTool[] | undefined = options.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}
