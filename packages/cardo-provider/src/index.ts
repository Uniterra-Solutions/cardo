/**
 * Register a {@link CardoAdapter} for the `cardo` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-cardo` user-settings section (`ctx.settings`) and resolves the API key
 * through the optional credential seam (`ctx.credentials`), so a changed base
 * URL, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes. The plugin also serves model discovery for the
 * `llm-cardo` settings namespace by interrogating `GET {baseURL}/models`, and
 * a `models-dev-params` RPC that matches gateway ids against models.dev.
 *
 * @module @cardo/cardo-provider
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {
  assertUsableApiKey,
  LlmError,
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import {
  deepEqualJson,
  installSettingsSection,
  settingsNamespace,
} from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_EXCLUDE_PATTERNS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  CardoAdapter,
  normalizeBaseUrl,
  PKG,
} from './adapter.ts';
import type { CardoCatalogModel, CardoConnectionOptions, GatewayApi } from './adapter.ts';
import type { ProviderHints, ModelsDevParamsRequest } from './types.ts';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_EXCLUDE_PATTERNS,
  DEFAULT_PROVIDER_HINTS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  matchModelsDev,
  modelNameFromId,
  CardoAdapter,
  normalizeBaseUrl,
  PKG,
} from './adapter.ts';
export { serializeRequest as serializeChatRequest } from './serialize-chat.ts';
export { serializeRequest as serializeResponsesRequest } from './serialize-response.ts';
export { translate as translateChat } from './translate-chat.ts';
export { translate as translateResponses } from './translate-response.ts';
export type { CardoAdapterOptions, CardoConnectionOptions, GatewayApi } from './adapter.ts';
export type * from './types.ts';

export const name = 'llm-cardo';
export const inject = ['llm'];

const NS = settingsNamespace('llm-cardo');
/** Fixed credential reference for the gateway API key. */
const API_KEY_REF = 'cardo';
/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'CARDO_BASE_URL';
/** Placeholder gateway base used when neither config nor environment names one. */
export const DEFAULT_BASE_URL = 'https://cardo.example.com/v1';
/** The single provider route this plugin owns. */
const PROVIDER = 'cardo';

/** Plugin config, validated by schemastery, doubling as the settings-section shape. */
export interface Config {
  /** Gateway base including the `/v1` prefix; falls back to $CARDO_BASE_URL then the placeholder. */
  baseURL?: string;
  /** Default wire protocol for models that do not pin one. */
  api?: GatewayApi;
  /** Advisory model catalog. */
  models?: CardoCatalogModel[];
  /** Case-insensitive id substrings excluding discovered non-chat models. */
  modelExcludePatterns?: string[];
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number;
  /** Default per-request output cap. */
  maxTokens?: number;
  /** Maximum gateway idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number;
  /** Forward proxy for the models.dev catalog download. */
  proxy?: ProxyConfig;
  /** Match-shaping hints for the models.dev params lookup. */
  providerHints?: ProviderHints;
  /** Provider-owned model-request retry policy. */
  retryPolicy?: RetryPolicyConfig;
}

/** Forward-proxy settings for the models.dev catalog download. */
export interface ProxyConfig {
  /** Whether the proxy is used; defaults to false. */
  enabled?: boolean;
  /** Proxy URL; presets default to `http://127.0.0.1:7890`. */
  url?: string;
}

const API_SCHEMA = z.string().pattern(/^(chat-completions|responses)$/) as unknown as z<GatewayApi>;

const catalogModel: z<CardoCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  api: API_SCHEMA,
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string(),
});

/** Default forward proxy: the conventional Clash port on loopback. */
export const DEFAULT_PROXY_URL = 'http://127.0.0.1:7890';

const proxySchema: z<ProxyConfig> = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(DEFAULT_PROXY_URL),
});

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  api: API_SCHEMA.default('chat-completions'),
  models: z.array(catalogModel).default([]),
  modelExcludePatterns: z.array(z.string()).default([...DEFAULT_MODEL_EXCLUDE_PATTERNS]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  proxy: proxySchema.default({ enabled: false, url: DEFAULT_PROXY_URL }),
  providerHints: z.object({
    defaults: z.object({}),
    models: z.object({}),
  }),
  retryPolicy: RetryPolicySchema,
});

/** One resolution's complete request facts. */
export type ResolvedCardoOptions = CardoConnectionOptions;

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly CardoCatalogModel[] | undefined): CardoCatalogModel[] {
  const seen = new Set<string>();
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error(`${PKG}: catalog model ids must be non-empty`);
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`${PKG}: catalog model "${model.id}" has an empty name`);
    }
    if (
      model.contextWindow !== undefined &&
      (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)
    ) {
      throw new Error(
        `${PKG}: catalog model "${model.id}" contextWindow must be a positive integer`,
      );
    }
    if (
      model.maxTokens !== undefined &&
      (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)
    ) {
      throw new Error(`${PKG}: catalog model "${model.id}" maxTokens must be a positive integer`);
    }
    if (seen.has(model.id)) throw new Error(`${PKG}: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    for (const effort of model.reasoningEfforts ?? []) {
      if (effort.length === 0)
        throw new Error(`${PKG}: catalog model "${model.id}" has an empty reasoning effort`);
    }
    if (
      model.defaultReasoningEffort !== undefined &&
      !(model.reasoningEfforts ?? []).includes(model.defaultReasoningEffort)
    ) {
      throw new Error(
        `${PKG}: catalog model "${model.id}" default reasoning effort "${model.defaultReasoningEffort}" is not among its reasoning efforts`,
      );
    }
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.api === undefined ? {} : { api: model.api }),
      ...(model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
        ? {}
        : { reasoningEfforts: model.reasoningEfforts }),
      ...(model.defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort: model.defaultReasoningEffort }),
    };
  });
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 */
export function resolveAdapterOptions(
  config: Config,
  environment?: ReturnType<typeof launchEnvironmentOf>,
): ResolvedCardoOptions {
  const named =
    config.baseURL !== undefined && config.baseURL.trim().length > 0
      ? config.baseURL
      : environment?.get(BASE_URL_ENV)?.value;
  const rawBase = named !== undefined && named.trim().length > 0 ? named : DEFAULT_BASE_URL;
  const modelExcludePatterns = config.modelExcludePatterns ?? [...DEFAULT_MODEL_EXCLUDE_PATTERNS];
  for (const pattern of modelExcludePatterns) {
    if (pattern.length === 0)
      throw new Error(`${PKG}: modelExcludePatterns entries must be non-empty`);
  }
  if (
    config.defaultContextWindow !== undefined &&
    (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)
  ) {
    throw new Error(`${PKG}: defaultContextWindow must be a positive integer`);
  }
  if (
    config.maxTokens !== undefined &&
    (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)
  ) {
    throw new Error(`${PKG}: maxTokens must be a positive safe integer`);
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (
    !Number.isFinite(streamIdleTimeoutMs) ||
    streamIdleTimeoutMs <= 0 ||
    streamIdleTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `${PKG}: streamIdleTimeoutMs must be a positive finite number no greater than ${String(MAX_TIMER_DELAY_MS)}`,
    );
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const proxyEnabled = config.proxy?.enabled === true;
  const proxyUrlRaw = config.proxy?.url ?? DEFAULT_PROXY_URL;
  if (proxyEnabled) {
    try {
      new URL(proxyUrlRaw);
    } catch {
      throw new Error(`${PKG}: proxy.url must be an absolute URL (got: ${proxyUrlRaw})`);
    }
    if (!/^https?:$/.test(new URL(proxyUrlRaw).protocol)) {
      throw new Error(`${PKG}: proxy.url must be an http(s) URL (got: ${proxyUrlRaw})`);
    }
  }
  return {
    baseURL: normalizeBaseUrl(rawBase),
    apiKeyRef: credentialRef(API_KEY_REF),
    models: resolveModels(config.models),
    api: config.api ?? 'chat-completions',
    modelExcludePatterns,
    defaultContextWindow,
    streamIdleTimeoutMs,
    ...(proxyEnabled ? { proxyUrl: proxyUrlRaw } : {}),
    providerHints: {
      defaults: { ...config.providerHints?.defaults },
      models: { ...config.providerHints?.models },
    },
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${PKG}: retryPolicy`),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  };
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config;
  let lastRaw: Config | undefined;
  let lastGood: ResolvedCardoOptions | undefined;
  const options = (): ResolvedCardoOptions => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error(
        `${PKG}: keeping the last good configuration after an invalid settings section`,
      );
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  const resolveApiKey = async (connection: ResolvedCardoOptions): Promise<string> => {
    const ref = connection.apiKeyRef;
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, PKG, ref);
    }
    throw new LlmError(
      `${PKG}: no API key for provider route "${PROVIDER}"; configure it on the Cardo` +
        ` settings page in dsh web (credentials reference "${ref}")`,
      'MISSING_CREDENTIAL',
    );
  };

  // Official-vendor index for the models.dev params panel.
  let indexCache: { routes: string; byModel: Map<string, string> } | undefined;
  const officialProviderOf = async (modelId: string): Promise<string | undefined> => {
    const routes = ctx.llm
      .listProviders()
      .map((provider) => provider.id)
      .sort()
      .join(',');
    if (indexCache === undefined || indexCache.routes !== routes) {
      const byModel = new Map<string, string>();
      for (const provider of ctx.llm.listProviders()) {
        if (provider.id === PROVIDER) continue;
        try {
          for (const model of await ctx.llm.listModels(provider.id)) {
            byModel.set(model.id, provider.id);
          }
        } catch {
          // An unlistable route contributes nothing; other routes still can.
        }
      }
      indexCache = { routes, byModel };
    }
    return indexCache.byModel.get(modelId);
  };

  const adapter = new CardoAdapter({ options, resolveApiKey, officialProviderOf });
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Cardo Gateway',
      settingsNs: NS,
      settingsPath: [],
      // The adapter knows this route only because configuration declared it.
      declared: true,
    },
  ]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };
  ctx.llm.registerModelDiscovery(NS, (request) => adapter.discoverModels(request));

  // Host-side endpoint for the「更新模型信息」action.
  ctx.inject(['connection'], (cctx) => {
    const connection = cctx.get('connection') as HostConnectionHandle;
    cctx.effect(
      () =>
        connection.rpc.handle(
          '/llm-cardo',
          (endpoint: string, payload: unknown, signal: AbortSignal) => {
            if (endpoint !== 'models-dev-params') {
              return Promise.resolve({
                ok: false as const,
                error: {
                  code: 'internal' as const,
                  message: `llm-cardo: unknown endpoint ${endpoint}`,
                  details: {},
                },
              });
            }
            const request = payload as ModelsDevParamsRequest;
            return adapter
              .fetchModelsDevParams(request, signal)
              .then((value) => ({ ok: true as const, value }))
              .catch((error: unknown) => ({
                ok: false as const,
                error: {
                  code: 'internal' as const,
                  message: error instanceof Error ? error.message : String(error),
                  details: {},
                },
              }));
          },
          { authority: 'loopback' },
        ),
      'llm-cardo: models-dev RPC channel',
    );
  });

  installSettingsSection(ctx, NS, Config, config, {
    validate: (value) => {
      resolveAdapterOptions(value, launchEnvironmentOf(ctx));
    },
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts,
  });
}
