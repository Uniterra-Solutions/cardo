/**
 * The uniterra dual-protocol gateway adapter: OpenAI Chat Completions AND
 * Responses API over any OpenAI-compatible gateway, with models.dev context /
 * output auto-detection. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * Protocol selection is per model: each catalog row may pin
 * `api: 'chat-completions' | 'responses'`, and a connection-level default
 * covers un-pinned models. The stream path routes by the resolved protocol —
 * serialize + endpoint + SSE translation differ per protocol.
 *
 * @module @uniterra-solutions/uniterra-provider/adapter
 */

import {
  assertUsableApiKey,
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { serializeRequest as serializeChat } from './serialize-chat.ts';
import { translate as translateChat } from './translate-chat.ts';
import { serializeRequest as serializeResponses } from './serialize-response.ts';
import { translate as translateResponses } from './translate-response.ts';
import { parseSse } from './sse.ts';
import type {
  ModelsDevApi,
  ModelsDevMatch,
  ModelsDevModel,
  ModelsDevParamsRequest,
  ModelsDevParamsResponse,
  ProviderHints,
  WireError,
  WireModelList,
} from './types.ts';

/** Prefix for adapter-raised diagnostics. */
export const PKG = 'uniterra-provider';

/** Wire protocols this adapter speaks. */
export type GatewayApi = 'chat-completions' | 'responses';

/** Default case-insensitive id substrings excluding non-chat models from discovery. */
export const DEFAULT_MODEL_EXCLUDE_PATTERNS: readonly string[] = ['embed', 'rerank', 'ranker'];

/** One optional model entry advertised by this adapter. */
export interface UniterraCatalogModel {
  /** Wire model id accepted by the configured gateway. */
  id: string;
  /** Selector label; defaults to {@link id}. */
  name?: string;
  /** Optional selector detail for deployments with similar model variants. */
  description?: string;
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number;
  /** Per-request output cap for this model; omission falls back to the profile's maxTokens. */
  maxTokens?: number;
  /** Wire protocol this model speaks; omission uses the connection default. */
  api?: GatewayApi;
  /** Supported reasoning-effort ids; presence offers the effort selector. */
  reasoningEfforts?: string[];
  /** Preset default effort for this model; must be one of {@link reasoningEfforts}. */
  defaultReasoningEffort?: string;
}

/** Validated connection facts for one operation. */
export interface UniterraConnectionOptions {
  /** Gateway base including the `/v1` prefix; `/chat/completions` and `/responses` are appended. */
  baseURL: string;
  /** Credential reference resolved per request. */
  apiKeyRef: CredentialRef;
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly UniterraCatalogModel[];
  /** Default wire protocol for models that do not pin one. */
  api: GatewayApi;
  /** Case-insensitive id substrings excluding discovered non-chat models. */
  modelExcludePatterns: readonly string[];
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number;
  /** Default per-request output cap; when absent, no cap is materialized or sent. */
  maxTokens?: number;
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number;
  /** Forward proxy for the models.dev catalog download, when enabled. */
  proxyUrl?: string;
  /** Match-shaping hints for the models.dev params lookup. */
  providerHints: ProviderHints;
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy;
}

/** Constructor options for {@link UniterraAdapter}. */
export interface UniterraAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => UniterraConnectionOptions;
  /** Resolve the bearer token for one request's connection facts. */
  resolveApiKey: (connection: UniterraConnectionOptions) => Promise<string>;
  /** Name the provider route that officially serves a model id, for models.dev arbitration. */
  officialProviderOf?: (modelId: string) => Promise<string | undefined>;
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default context capacity when neither the catalog nor config names one. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';

/** The public, provider-agnostic model catalog this feature reads. */
export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
/** One-shot download budget for the catalog fetch. */
const MODELS_DEV_TIMEOUT_MS = 30_000;

/**
 * One provider entry from the catalog, narrowed to what the feature fills.
 */
function modelsDevMatch(provider: string, entry: ModelsDevModel): ModelsDevMatch | undefined {
  const contextWindow = entry.limit?.context;
  const maxTokens = entry.limit?.output;
  const reasoningEfforts = entry.reasoning_options
    ?.filter((option) => option.type === 'effort')
    .flatMap((option) =>
      (option.values ?? []).filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    );
  if (contextWindow === undefined && maxTokens === undefined) return undefined;
  return {
    provider,
    ...(entry.name !== undefined && entry.name.length > 0 ? { name: entry.name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoningEfforts !== undefined && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
  };
}

/** Built-in family-prefix hints for models.dev provider arbitration. */
export const DEFAULT_PROVIDER_HINTS: Readonly<ProviderHints> = {
  defaults: {
    glm: 'zai',
    gpt: 'openai',
    o: 'openai',
    claude: 'anthropic',
    deepseek: 'deepseek',
    gemini: 'google',
    grok: 'xai',
    hunyuan: 'tencent',
    qwen: 'alibaba',
    kimi: 'moonshotai',
    mimo: 'xiaomi',
    minimax: 'minimax',
  },
};

/** The provider a hint names for one gateway id, if any. */
function hintedProvider(id: string, bare: string, hints?: ProviderHints): string | undefined {
  const exact = hints?.models?.[id] ?? hints?.models?.[bare];
  if (exact !== undefined) return exact;
  const lower = bare.toLowerCase();
  const entries = Object.entries({ ...DEFAULT_PROVIDER_HINTS.defaults, ...hints?.defaults });
  const hit = entries
    .filter(([prefix]) => lower.startsWith(prefix.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit?.[1];
}

/**
 * Find every catalog entry one gateway model id can mean, official first.
 */
export function matchModelsDev(
  api: ModelsDevApi,
  id: string,
  hints?: ProviderHints,
): ModelsDevMatch[] {
  const bare = id.slice(id.lastIndexOf('/') + 1);
  const keys = new Set<string>([id, bare]);
  const hinted = hintedProvider(id, bare, hints);
  const exact = new Map<string, ModelsDevMatch>();
  const near = new Map<string, ModelsDevMatch>();
  for (const [provider, catalog] of Object.entries(api)) {
    const models = catalog.models;
    if (models === undefined || typeof models !== 'object') continue;
    for (const key of keys) {
      const entry = models[key];
      if (entry === undefined || typeof entry !== 'object') continue;
      const match = modelsDevMatch(provider, entry);
      if (match !== undefined) exact.set(provider, match);
    }
    if (provider === hinted && !exact.has(provider)) {
      const hit = Object.keys(models)
        .filter((key) => key.includes(bare) || bare.includes(key))
        .map((key) => ({ key, entry: models[key] }))
        .sort((a, b) => a.key.length - b.key.length)[0];
      const entry = hit?.entry;
      const match = entry === undefined ? undefined : modelsDevMatch(provider, entry);
      if (match !== undefined) near.set(provider, match);
    }
  }
  const ordered: ModelsDevMatch[] = [];
  const seen = new Set<string>();
  const push = (match: ModelsDevMatch, official: boolean): void => {
    if (seen.has(match.provider)) return;
    seen.add(match.provider);
    ordered.push(official ? { ...match, official: true } : match);
  };
  const hintedMatch = exact.get(hinted ?? '') ?? near.get(hinted ?? '');
  if (hinted !== undefined && hintedMatch !== undefined) push(hintedMatch, true);
  for (const match of exact.values()) push(match, false);
  for (const match of near.values()) push(match, false);
  return ordered;
}

/**
 * Normalize a user-supplied gateway base: trim, drop trailing slashes, require http(s).
 */
export function normalizeBaseUrl(raw: string): string {
  const base = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    throw new Error(
      `${PKG}: baseURL must be an absolute http(s) URL including the /v1 prefix, e.g. http://gw.local:3000/v1 (got: ${raw.trim()})`,
    );
  }
  return base;
}

function modelInfo(provider: string, model: UniterraCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: ['text'],
  };
}

/** Effort intensity ordering, strongest first; unknown ids rank lowest. */
const EFFORT_RUNG: Readonly<Record<string, number>> = {
  max: 7,
  xhigh: 6,
  high: 5,
  medium: 4,
  low: 3,
  minimal: 2,
  none: 1,
  default: 0,
};

/** The highest-ranked effort id in a catalog-declared list. */
function highestEffort(efforts: readonly string[]): string {
  return [...efforts].sort((a, b) => (EFFORT_RUNG[b] ?? -1) - (EFFORT_RUNG[a] ?? -1))[0] as string;
}

/** Brand words that keep their own casing instead of first-letter capital. */
const BRAND_SPELLING: Readonly<Record<string, string>> = {
  glm: 'GLM',
  gpt: 'GPT',
  deepseek: 'DeepSeek',
};

/**
 * Derive a human display name from a gateway model id when the listing
 * supplied none.
 */
export function modelNameFromId(id: string): string {
  const slash = id.lastIndexOf('/');
  const prefix = slash === -1 ? undefined : id.slice(0, slash);
  const words = id
    .slice(slash + 1)
    .split('-')
    .filter((word) => word.length > 0);
  const spelled = words
    .map((word, at) => {
      if (word.length === 1) return word.toUpperCase();
      const brand = BRAND_SPELLING[word];
      if (brand !== undefined) return brand;
      let result = word.charAt(0).toUpperCase() + word.slice(1);
      if (at === words.length - 1) {
        result = result.replace(
          /([0-9.])([bkm])$/,
          (_match: string, head: string, tail: string) => head + tail.toUpperCase(),
        );
      }
      return result;
    })
    .join(' ');
  return prefix === undefined ? spelled : `${spelled}[${prefix}]`;
}

/** Display name for one gateway model id. */
export function displayModelName(id: string, listed?: string): string {
  if (listed !== undefined && listed.length > 0) return listed;
  return modelNameFromId(id);
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id');
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

/** Map an HTTP status to a stable LlmError code. */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${String(status)}`;
}

/** Resolve the wire protocol for one model. */
function protocolOf(connection: UniterraConnectionOptions, model: string): GatewayApi {
  return connection.models.find((entry) => entry.id === model)?.api ?? connection.api;
}

/**
 * The uniterra gateway adapter. One instance serves every model name it was
 * registered under, routing each call to Chat Completions or Responses by the
 * model's pinned (or default) protocol.
 */
export class UniterraAdapter extends LlmAdapter {
  constructor(private readonly config: UniterraAdapterOptions) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Uniterra Gateway' };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy;
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    const defaultMaxTokens = configured?.maxTokens ?? connection.maxTokens;
    return Promise.resolve({
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured)),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      ...(configured?.reasoningEfforts !== undefined && configured.reasoningEfforts.length > 0
        ? {
            reasoning: {
              efforts: configured.reasoningEfforts.map((effort) => ({
                id: ReasoningEffortId(effort),
                name: effort.charAt(0).toUpperCase() + effort.slice(1),
              })),
              ...(configured.defaultReasoningEffort !== undefined &&
              configured.reasoningEfforts.includes(configured.defaultReasoningEffort)
                ? { defaultEffort: ReasoningEffortId(configured.defaultReasoningEffort) }
                : { defaultEffort: ReasoningEffortId(highestEffort(configured.reasoningEfforts)) }),
            },
          }
        : {}),
      ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    });
  }

  /**
   * Interrogate one gateway endpoint for the models it advertises, serving the
   * settings-namespace discovery the plugin registered.
   */
  async discoverModels(request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> {
    const connection = this.config.options();
    const base =
      request.baseURL !== undefined && request.baseURL.length > 0
        ? normalizeBaseUrl(request.baseURL)
        : connection.baseURL;
    const apiKey =
      request.apiKey !== undefined
        ? assertUsableApiKey(request.apiKey, PKG, 'the draft credential')
        : await this.config.resolveApiKey(connection);
    let response: Response;
    try {
      response = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...attributionHeaders(),
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      if (request.signal?.aborted) throw error;
      throw new LlmError(`${PKG}: model discovery request to ${base} failed`, 'TRANSPORT', {
        cause: error,
      });
    }
    if (!response.ok) {
      let providerError: WireError['error'];
      try {
        providerError = ((await response.json()) as WireError).error;
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the failure.
      }
      const id = requestId(response.headers);
      throw new LlmError(
        providerError?.message ?? `${PKG}: model discovery error (HTTP ${String(response.status)})`,
        httpErrorCode(response.status, providerError),
        {
          status: response.status,
          ...(id === undefined ? {} : { requestId: id }),
        },
      );
    }
    let list: WireModelList;
    try {
      list = (await response.json()) as WireModelList;
    } catch {
      throw new LlmError(
        `${PKG}: model discovery from ${base} returned a malformed body`,
        'MALFORMED_RESPONSE',
      );
    }
    const catalog = new Map(connection.models.map((model) => [model.id, model]));
    const excludes = connection.modelExcludePatterns.map((pattern) => pattern.toLowerCase());
    const models: LlmDiscoveredModel[] = [];
    for (const entry of list.data ?? []) {
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
      const id = entry.id.toLowerCase();
      if (excludes.some((pattern) => id.includes(pattern))) continue;
      const known = catalog.get(entry.id);
      models.push({
        id: entry.id,
        name: displayModelName(entry.id, entry.name),
        ...(known?.contextWindow !== undefined ? { contextWindow: known.contextWindow } : {}),
        ...(known?.maxTokens !== undefined ? { maxTokens: known.maxTokens } : {}),
      });
    }
    models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return models;
  }

  /**
   * Download the models.dev catalog (optionally through the configured forward
   * proxy) and match every requested gateway id against it.
   */
  async fetchModelsDevParams(
    request: ModelsDevParamsRequest,
    signal: AbortSignal,
  ): Promise<ModelsDevParamsResponse> {
    const proxyUrl =
      request.proxyUrl !== undefined && request.proxyUrl.length > 0
        ? request.proxyUrl
        : this.config.options().proxyUrl;
    const dispatcher = proxyUrl !== undefined ? new ProxyAgent(proxyUrl) : undefined;
    let api: ModelsDevApi;
    try {
      const headers = { accept: 'application/json', ...attributionHeaders() };
      const reqSignal = AbortSignal.any([signal, AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS)]);
      // With a proxy the request MUST ride undici's own fetch: Node's global
      // fetch brand-checks `dispatcher` against its INTERNAL undici instance
      // and rejects a ProxyAgent minted by the npm package.
      const response =
        dispatcher === undefined
          ? await fetch(MODELS_DEV_API_URL, { headers, signal: reqSignal })
          : await undiciFetch(MODELS_DEV_API_URL, { headers, signal: reqSignal, dispatcher });
      if (!response.ok) {
        throw new LlmError(
          `models.dev catalog fetch failed (HTTP ${String(response.status)})`,
          httpErrorCode(response.status),
          { status: response.status },
        );
      }
      api = (await response.json()) as ModelsDevApi;
    } catch (error: unknown) {
      if (error instanceof LlmError) throw error;
      if (signal.aborted) throw error;
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : error instanceof Error
            ? `: ${error.message}`
            : '';
      const remedy =
        proxyUrl !== undefined
          ? ` — the proxy at ${proxyUrl} is unreachable; check that it is running, or change or disable the proxy setting`
          : ' — if the direct route cannot reach models.dev, enable the proxy';
      throw new LlmError(`models.dev catalog fetch failed${cause}${remedy}`, 'TRANSPORT', {
        cause: error,
      });
    } finally {
      void dispatcher?.close().catch(() => {});
    }
    const hints = this.config.options().providerHints;
    return {
      models: await Promise.all(
        request.modelIds.map(async (id) => ({
          id,
          matches: await this.prioritizeOfficial(id, matchModelsDev(api, id, hints)),
        })),
      ),
    };
  }

  /** Registry-based official priority, complementing the hint-driven one. */
  private async prioritizeOfficial(
    id: string,
    matches: ModelsDevMatch[],
  ): Promise<ModelsDevMatch[]> {
    const hook = this.config.officialProviderOf;
    if (
      hook === undefined ||
      matches.length < 2 ||
      matches.some((match) => match.official === true)
    )
      return matches;
    const slash = id.lastIndexOf('/');
    const official =
      (await hook(id)) ?? (slash === -1 ? undefined : await hook(id.slice(slash + 1)));
    if (official === undefined) return matches;
    const at = matches.findIndex((match) => match.provider === official);
    const hit = at === -1 ? undefined : matches[at];
    if (hit === undefined) return matches;
    const rest = matches.filter((_match, index) => index !== at);
    return [{ ...hit, official: true }, ...rest];
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey(connection);
    const consumer = new AbortController();
    const upstream =
      options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal]);
    using watchdog = idleWatchdog(
      upstream,
      connection.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    );
    const iterator = this.request(options, watchdog.signal, connection, apiKey, () => {
      watchdog.pulse();
    })[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      // The loop only exits through the iterator's own `done`; `for(;;)` is
      // the lint-clean spelling of an intentional infinite loop.
      for (;;) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `${PKG}: stream idle timeout after ${String(connection.streamIdleTimeoutMs)}ms`,
          'TIMEOUT',
          { cause: error },
        );
      }
      if (options.signal?.aborted) {
        throw new LlmError(`${PKG}: request aborted by caller`, 'ABORTED', { cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError(`${PKG}: stream from ${connection.baseURL} failed`, 'TRANSPORT', {
        cause: error,
      });
    } finally {
      consumer.abort(`${PKG}: stream consumer stopped`);
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async *request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: UniterraConnectionOptions,
    apiKey: string,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const protocol = protocolOf(connection, options.model);
    const body = protocol === 'responses' ? serializeResponses(options) : serializeChat(options);
    const payload = JSON.stringify(body);
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
    };

    const endpoint = protocol === 'responses' ? '/responses' : '/chat/completions';
    let response: Response;
    try {
      response = await fetch(`${connection.baseURL}${endpoint}`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      throw new LlmError(`${PKG}: request to ${connection.baseURL} failed`, 'TRANSPORT', {
        cause: error,
      });
    }

    if (!response.ok) {
      let message = `${PKG}: error (HTTP ${String(response.status)})`;
      let providerError: WireError['error'];
      try {
        const parsed = (await response.json()) as WireError;
        providerError = parsed.error;
        if (providerError?.message) message = providerError.message;
      } catch {
        // Only swallow error-body parsing.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      const id = requestId(response.headers);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      });
    }
    if (!response.body) {
      throw new LlmError(`${PKG}: returned no response body`, 'EMPTY_RESPONSE');
    }

    const sse = parseSse(response.body, onComment);
    yield* protocol === 'responses' ? translateResponses(sse) : translateChat(sse);
  }
}
