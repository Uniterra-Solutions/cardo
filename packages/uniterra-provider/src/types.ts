/**
 * Uniterra dual-protocol wire formats: OpenAI Chat Completions
 * (`POST {baseURL}/chat/completions`) and OpenAI Responses API
 * (`POST {baseURL}/responses`). Types only — serialization and translation
 * live in their protocol modules.
 *
 * @module @uniterra-solutions/uniterra-provider/types
 */

// ── shared ─────────────────────────────────────────────────────────────────

/** One non-2xx error body (OpenAI-compatible shape). */
export interface WireError {
  error?: { message?: string; type?: string; code?: string };
}

/** `GET {baseURL}/models` response (OpenAI models.list shape). */
export interface WireModelList {
  object?: 'list';
  data?: WireModelEntry[];
}

/** One advertised model entry; gateways disclose an id and nothing else. */
export interface WireModelEntry {
  id: string;
  /** Human-readable name when the gateway supplies one. */
  name?: string;
  /** OpenAI `owned_by` field when present. */
  owned_by?: string;
}

// ── Chat Completions protocol ──────────────────────────────────────────────

/** Request body for `POST {baseURL}/chat/completions`. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: ChatTool[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  /** Optional reasoning-effort id (OpenAI/DeepSeek-style `reasoning_effort`). */
  reasoning_effort?: string;
  /** Optional structured-output constraint (OpenAI `response_format`). */
  response_format?: { type: 'json_object' | 'json_schema'; schema?: Record<string, unknown> };
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: ChatToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A completed tool call replayed on an assistant history message. */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One entry of the request `tools` array. */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface ChatChunk {
  choices?: ChatChoice[];
  usage?: ChatUsage | null;
}

/** One streamed choice; `finish_reason` is non-null only on its terminal chunk. */
export interface ChatChoice {
  delta?: ChatDelta;
  /**
   * Full-message replay attached to the terminal chunk (DashScope compatible
   * mode carries the whole `reasoning_content` here with empty deltas).
   */
  message?: ChatDelta;
  finish_reason?: string | null;
}

/**
 * The incremental content of one streamed choice. Reasoning arrives under
 * three field names across OpenAI-compatible gateways: `reasoning_content`
 * (DeepSeek / Qwen / GLM style) and `reasoning` (OpenRouter/aggregator style).
 */
export interface ChatDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: ChatToolCallDelta[];
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate. */
export interface ChatToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Wire token accounting. `prompt_tokens` INCLUDES cache hits. */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

// ── Responses API protocol ─────────────────────────────────────────────────

/** Request body for `POST {baseURL}/responses`. */
export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  stream: true;
  tools?: ResponsesTool[];
  temperature?: number;
  max_output_tokens?: number;
  /** Optional reasoning-effort control (OpenAI/DeepSeek-style `reasoning.effort`). */
  reasoning?: { effort: string };
  /** Optional structured-output constraint (OpenAI `text.format`). */
  text?: { format?: { type: 'json_object' | 'json_schema'; schema?: Record<string, unknown> } };
  store?: false;
  stop?: string[];
}

/** One request input item (messages + prior tool-call/reasoning items). */
export type ResponsesInputItem =
  | { role: 'system'; content: ResponsesContent[] }
  | { role: 'user'; content: ResponsesContent[] }
  | { role: 'assistant'; content: ResponsesContent[] }
  | {
      type: 'reasoning';
      id: string;
      content: Array<{ type: 'reasoning_text'; text: string }>;
      summary: Array<{ type: 'summary_text'; text: string }>;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    };

/** Responses content blocks (text only — this adapter is text-only). */
export type ResponsesContent =
  { type: 'input_text'; text: string } | { type: 'output_text'; text: string };

/** One entry of the request `tools` array. */
export interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/** SSE event types the Responses API streams (non-error subset we handle). */
export type ResponsesEvent =
  | { type: 'response.created' }
  | { type: 'response.in_progress' }
  | { type: 'response.output_item.added'; item: ResponsesStreamedItem }
  | {
      type: 'response.content_part.added';
      item_id: string;
      output_index: number;
      part: ResponsesContentPart;
    }
  | {
      type: 'response.content_part.done';
      item_id: string;
      output_index: number;
      part: ResponsesContentPart;
    }
  | { type: 'response.output_text.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.output_text.done'; item_id: string; output_index: number; text: string }
  | { type: 'response.reasoning_text.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.reasoning_text.done'; item_id: string; output_index: number; text: string }
  | {
      type: 'response.reasoning_summary_text.delta';
      item_id: string;
      output_index: number;
      summary_index: number;
      delta: string;
    }
  | {
      type: 'response.reasoning_summary_text.done';
      item_id: string;
      output_index: number;
      summary_index: number;
      text: string;
    }
  | {
      type: 'response.reasoning_summary_part.added';
      item_id: string;
      output_index: number;
      summary_index: number;
      part: { type: 'summary_text'; text?: string };
    }
  | {
      type: 'response.reasoning_summary_part.done';
      item_id: string;
      output_index: number;
      summary_index: number;
      part: { type: 'summary_text'; text: string };
    }
  | {
      type: 'response.function_call_arguments.delta';
      item_id: string;
      output_index: number;
      delta: string;
    }
  | {
      type: 'response.function_call_arguments.done';
      item_id: string;
      output_index: number;
      arguments: string;
    }
  | {
      type: 'response.output_item.done';
      item_id: string;
      output_index: number;
      item: ResponsesStreamedItem;
    }
  | { type: 'response.completed'; response: ResponsesCompleted }
  | { type: 'response.failed'; response: { error?: WireError['error'] } }
  | {
      type: 'response.incomplete';
      response: { incomplete_details?: { reason?: string }; output?: ResponsesStreamedItem[] };
    };

/** One content part within a streamed item (`response.content_part.*`). */
export type ResponsesContentPart =
  | { type: 'output_text'; text: string }
  | { type: 'reasoning_text'; text?: string; reasoning?: string };

/** A streamed output item (reasoning, message, or function call). */
export type ResponsesStreamedItem =
  | {
      type: 'message';
      id: string;
      status: 'in_progress' | 'completed';
      role: 'assistant';
      content: Array<{ type: 'output_text'; text: string }>;
    }
  | {
      type: 'function_call';
      id: string;
      status: 'in_progress' | 'completed';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'reasoning';
      id: string;
      status?: 'in_progress' | 'completed' | 'incomplete';
      content?: Array<{ type: 'reasoning_text'; text: string }>;
      summary?: Array<{ type: 'summary_text'; text: string }>;
    };

/** The terminal `response.completed` payload, carrying usage. */
export interface ResponsesCompleted {
  id: string;
  status: 'completed';
  output: ResponsesStreamedItem[];
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

// ── models.dev catalog ─────────────────────────────────────────────────────

/** Root of `https://models.dev/api.json`: one entry per provider id. */
export interface ModelsDevApi {
  [provider: string]: {
    models?: Record<string, ModelsDevModel>;
  };
}

/** Match-shaping hints for the models.dev params lookup. */
export interface ProviderHints {
  /** Family prefix → provider id, consulted before catalog order. */
  defaults?: Record<string, string>;
  /** Exact gateway model id → provider id; wins over {@link defaults}. */
  models?: Record<string, string>;
}

/** One model entry in the models.dev catalog. */
export interface ModelsDevModel {
  name?: string;
  /** Capacity facts: `limit.context` and `limit.output` are token counts. */
  limit?: { context?: number; output?: number };
  /** How the model takes reasoning control; `effort` carries the levels. */
  reasoning_options?: Array<{ type: string; values?: Array<string | null> }>;
}

/** One models.dev provider match for a gateway model id. */
export interface ModelsDevMatch {
  /** models.dev provider id the entry lives under (e.g. `qwen`, `alibaba`). */
  provider: string;
  /** Human-readable name from the catalog entry, when present. */
  name?: string;
  /** Combined request/response context capacity (`limit.context`). */
  contextWindow?: number;
  /** Per-request output cap (`limit.output`). */
  maxTokens?: number;
  /** Supported reasoning-effort ids (`reasoning_options` type `effort`). */
  reasoningEfforts?: string[];
  /** True when this match's provider is the model's official vendor. */
  official?: boolean;
}

/** Request payload of the `models-dev-params` RPC endpoint. */
export interface ModelsDevParamsRequest {
  /** Gateway model ids to look up, verbatim. */
  modelIds: string[];
  /** Forward-proxy URL to route the api.json download through, when enabled. */
  proxyUrl?: string;
}

/** Response payload of the `models-dev-params` RPC endpoint. */
export interface ModelsDevParamsResponse {
  /** Per requested id: every provider entry that matched it, in catalog order. */
  models: Array<{ id: string; matches: ModelsDevMatch[] }>;
}
