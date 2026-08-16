/**
 * cardo-provider smoke + unit tests. Composition blocks (A–H) mount the real
 * plugin through cordis Contexts exactly as dsh-llm-newapi does; the dual
 * protocol (Block D/E) is what this plugin adds: the same GenerateOptions
 * serialize differently per protocol, and each protocol's SSE payloads
 * translate into the same StreamChunk vocabulary. All tests run on the built
 * `lib/` (the test script builds first), so they exercise the shipped code.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime, { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import SettingsProvider, { settingsNamespace } from '@deepseek-ai/dsh-settings';
import * as plugin from '../lib/index.js';

/** In-memory settings provider: the smallest real SettingsProvider subclass. */
class MemorySettings extends SettingsProvider {
  doc = {};

  constructor(ctx, options) {
    super(ctx);
    this.doc = structuredClone(options?.doc ?? {});
  }

  get writable() {
    return true;
  }

  load() {
    return Promise.resolve(structuredClone(this.doc));
  }

  async persist(ns, section) {
    this.doc[ns] = structuredClone(section);
  }
}

/** Minimal credentials service: resolve() only, from an in-memory store. */
class FakeCredentials extends Service {
  constructor(ctx, store) {
    super(ctx, 'credentials');
    this.store = store;
  }

  resolve(ref) {
    return Promise.resolve(
      this.store[ref] === undefined ? undefined : { value: this.store[ref], source: 'store' },
    );
  }
}

async function mountPlugin(ctx, config = {}) {
  return ctx.plugin(
    {
      name: plugin.name,
      inject: plugin.inject,
      Config: plugin.Config,
      apply: plugin.apply,
    },
    config,
  );
}

/** Stub fetch to answer a models listing and record the request. */
function stubModelsListing() {
  const originalFetch = globalThis.fetch;
  const asked = { url: '', auth: '' };
  globalThis.fetch = async (url, init) => {
    asked.url = String(url);
    asked.auth = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-chat' },
          { id: 'text-embedding-3-large' },
          { id: 'bge-reranker-v2-m3' },
          { id: 'Qwen/Reranker-Flash' },
          { id: 'gemini-2.5-pro' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return {
    asked,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Read every chunk a translated stream yields. */
async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/** SSE body for a Chat Completions stream with text + usage. */
async function* chatSse(payloads) {
  for (const payload of payloads) yield payload;
}

// ── Block A: registration faces and chat-only discovery filtering ──
{
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  const fiber = await mountPlugin(ctx);

  assert.deepEqual(
    ctx.llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name })),
    [{ id: 'cardo', name: 'Cardo Gateway' }],
  );

  const directory = ctx.llm.listConfigurableProviders();
  assert.equal(directory.length, 1);
  assert.equal(directory[0].provider, 'cardo');
  assert.equal(directory[0].displayName, 'Cardo Gateway');
  assert.equal(directory[0].settingsNs, 'llm-cardo');
  assert.deepEqual(directory[0].settingsPath, []);
  assert.equal(directory[0].declared, true);

  const { asked, restore } = stubModelsListing();
  let discovered;
  try {
    discovered = await ctx.llm.discoverModels('llm-cardo', {
      baseURL: 'http://gw.local:3000/v1/',
      apiKey: 'smoke-key',
    });
  } finally {
    restore();
  }

  assert.equal(asked.url, 'http://gw.local:3000/v1/models');
  assert.equal(asked.auth, 'Bearer smoke-key');
  assert.deepEqual(
    discovered.map((model) => model.id),
    ['deepseek-chat', 'gemini-2.5-pro'],
  );

  // HMR safety: disposing the fiber removes the route and the directory entry.
  await fiber.dispose();
  assert.deepEqual(ctx.llm.listProviders(), []);
  assert.deepEqual(ctx.llm.listConfigurableProviders(), []);
}

// ── Block B: the API key comes from the credentials service only ──
{
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await mountPlugin(ctx);
  await assert.rejects(
    ctx.llm.discoverModels('llm-cardo', { baseURL: 'http://gw.local:3000/v1' }),
    (error) =>
      error.code === 'MISSING_CREDENTIAL' &&
      error.message.includes('Cardo settings page') &&
      !error.message.includes('export'),
  );

  const ctx2 = new Context();
  await ctx2.plugin(LlmRuntime);
  await ctx2.plugin(FakeCredentials, { cardo: 'stored-key' });
  await mountPlugin(ctx2);
  const { asked, restore } = stubModelsListing();
  try {
    const found = await ctx2.llm.discoverModels('llm-cardo', { provider: 'cardo' });
    assert.equal(found.length, 2);
  } finally {
    restore();
  }
  assert.equal(asked.auth, 'Bearer stored-key');
}

// ── Block C: the settings write point refuses unserviceable sections ──
{
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(MemorySettings, {});
  await ctx.plugin(FakeCredentials, { cardo: 'block-c-key' });
  await mountPlugin(ctx);

  await assert.rejects(
    ctx.settings.update(settingsNamespace('llm-cardo'), { baseURL: 'not-a-url' }),
    (error) => error.message.includes('baseURL must be an absolute http(s) URL'),
  );

  // A serviceable section commits and the very next discovery uses it.
  await ctx.settings.update(settingsNamespace('llm-cardo'), {
    baseURL: 'http://settings-gw:9000/v1',
    api: 'responses',
  });
  const { asked, restore } = stubModelsListing();
  try {
    const found = await ctx.llm.discoverModels('llm-cardo', { provider: 'cardo' });
    assert.equal(found.length, 2);
  } finally {
    restore();
  }
  assert.equal(asked.url, 'http://settings-gw:9000/v1/models');
}

// ── Block D: dual-protocol serialization ──
{
  const base = {
    model: 'qwen3-32b',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'Be brief.',
    tools: [
      {
        name: 'get_weather',
        description: 'Weather lookup',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    temperature: 0.7,
    maxTokens: 2048,
  };

  // Chat Completions: messages + tools array, streaming with usage.
  const chat = plugin.serializeChatRequest(base);
  assert.equal(chat.model, 'qwen3-32b');
  assert.equal(chat.stream, true);
  assert.equal(chat.stream_options.include_usage, true);
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(chat.tools[0].function.name, 'get_weather');
  assert.equal(chat.max_tokens, 2048);
  assert.equal(chat.temperature, 0.7);

  // Responses: input items + tools at top level, no messages array.
  const responses = plugin.serializeResponsesRequest(base);
  assert.equal(responses.model, 'qwen3-32b');
  assert.equal(responses.stream, true);
  assert.deepEqual(responses.input, [
    { role: 'system', content: [{ type: 'input_text', text: 'Be brief.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]);
  assert.equal(responses.tools[0].name, 'get_weather');
  assert.equal(responses.max_output_tokens, 2048);
  assert.equal('messages' in responses, false);

  // Tool-call turns serialize to function_call items in the Responses input.
  const toolTurn = plugin.serializeResponsesRequest({
    model: 'm1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"x"}' }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'sunny' }] },
        ],
      },
    ],
  });
  assert.deepEqual(toolTurn.input, [
    { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"x"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'sunny' },
  ]);

  // Image content is refused on both wire routes.
  const imageMsg = {
    model: 'm1',
    messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] }],
  };
  assert.throws(
    () => plugin.serializeChatRequest(imageMsg),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  );
  assert.throws(
    () => plugin.serializeResponsesRequest(imageMsg),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  );
}

// ── Block E: dual-protocol SSE translation ──
{
  // Chat Completions: reasoning + text deltas, tool calls, finish + usage on
  // the [DONE] sentinel.
  const chatChunks = await collect(
    plugin.translateChat(
      chatSse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 't1', function: { name: 'f1', arguments: '{"a":' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        JSON.stringify({
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
        '[DONE]',
      ]),
    ),
  );
  assert.deepEqual(
    chatChunks.map((c) => c.type),
    [
      'block-start',
      'reasoning-delta',
      'block-start',
      'text-delta',
      'block-start',
      'tool-call-delta',
      'tool-call-delta',
      'block-end',
      'block-end',
      'block-end',
      'usage',
      'finish',
    ],
  );
  const chatText = chatChunks.find((c) => c.type === 'block-end' && c.block.type === 'text');
  assert.equal(chatText.block.text, 'Hello');
  const chatReason = chatChunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning');
  assert.equal(chatReason.block.text, 'think');
  const chatTool = chatChunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(chatTool.block.name, 'f1');
  assert.equal(chatTool.block.arguments, '{"a":1}');
  const chatFinish = chatChunks.find((c) => c.type === 'finish');
  assert.deepEqual(chatFinish.reason, { kind: 'tool-calls' });
  const chatUsage = chatChunks.find((c) => c.type === 'usage');
  assert.deepEqual(chatUsage.usage, {
    inputTokens: 7,
    outputTokens: 5,
    cacheReadTokens: 3,
    reasoningTokens: 2,
  });

  // Responses: output text deltas + reasoning, tool-call argument deltas, and
  // usage/finish on the terminal response.completed event — no [DONE].
  const responsesChunks = await collect(
    plugin.translateResponses(
      (async function* () {
        yield JSON.stringify({ type: 'response.created', sequence_number: 0 });
        yield JSON.stringify({
          type: 'response.reasoning_text.delta',
          item_id: 'r1',
          output_index: 0,
          delta: 'hmm',
        });
        yield JSON.stringify({
          type: 'response.output_text.delta',
          item_id: 'm1',
          output_index: 1,
          delta: 'Hello',
        });
        yield JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc1',
          output_index: 2,
          delta: '{"a":',
        });
        yield JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc1',
          output_index: 2,
          delta: '1}',
        });
        yield JSON.stringify({
          type: 'response.function_call_arguments.done',
          item_id: 'fc1',
          output_index: 2,
          arguments: '{"a":1}',
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_1',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 1 },
            },
          },
        });
      })(),
    ),
  );
  assert.deepEqual(
    responsesChunks.map((c) => c.type),
    [
      'block-start',
      'reasoning-delta',
      'block-start',
      'text-delta',
      'block-start',
      'tool-call-delta',
      'tool-call-delta',
      'block-end',
      'block-end',
      'block-end',
      'usage',
      'finish',
    ],
  );
  const respText = responsesChunks.find((c) => c.type === 'block-end' && c.block.type === 'text');
  assert.equal(respText.block.text, 'Hello');
  const respReason = responsesChunks.find(
    (c) => c.type === 'block-end' && c.block.type === 'reasoning',
  );
  assert.equal(respReason.block.text, 'hmm');
  const respTool = responsesChunks.find(
    (c) => c.type === 'block-end' && c.block.type === 'tool-call',
  );
  assert.equal(respTool.block.name, '');
  assert.equal(respTool.block.arguments, '{"a":1}');
  const respFinish = responsesChunks.find((c) => c.type === 'finish');
  assert.deepEqual(respFinish.reason, { kind: 'stop' });
  const respUsage = responsesChunks.find((c) => c.type === 'usage');
  assert.deepEqual(respUsage.usage, {
    inputTokens: 8,
    outputTokens: 5,
    cacheReadTokens: 2,
    reasoningTokens: 1,
  });

  // A failed response surfaces as an error finish.
  const failed = await collect(
    plugin.translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.failed',
          response: { error: { message: 'boom', code: 'rate_limit' } },
        });
      })(),
    ),
  );
  assert.deepEqual(failed[failed.length - 1].reason, {
    kind: 'error',
    failure: { message: 'boom', code: 'rate_limit' },
  });
}

// ── Block F: the models-dev RPC channel registers once connection starts ──
{
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await mountPlugin(ctx);

  const registered = [];
  class FakeConnection extends Service {
    constructor(child) {
      super(child, 'connection');
    }
    get rpc() {
      return {
        handle: (channel, handler, options) => {
          registered.push({ channel, handler, options });
          return () => Promise.resolve();
        },
      };
    }
  }
  await ctx.plugin(FakeConnection);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].channel, '/llm-cardo');
  assert.equal(registered[0].options.authority, 'loopback');

  const answer = await registered[0].handler('nope', {}, new AbortController().signal);
  assert.equal(answer.ok, false);
  assert.match(answer.error.message, /unknown endpoint nope/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause: new Error('connect ENETUNREACH') });
  };
  let failure;
  try {
    failure = await registered[0].handler(
      'models-dev-params',
      { modelIds: ['x'] },
      new AbortController().signal,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(failure.ok, false);
  assert.match(failure.error.message, /models\.dev catalog fetch failed/);
  assert.match(failure.error.message, /ENETUNREACH/);
  assert.match(failure.error.message, /enable the proxy/);
}

// ── Block G: models.dev matching with official-vendor hints ──
{
  const api = {
    qwen: {
      models: {
        'qwen-max': {
          limit: { context: 262144, output: 32768 },
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', null] }],
        },
      },
    },
    alibaba: {
      models: {
        'qwen-max': {
          name: 'Qwen Max (DashScope)',
          limit: { context: 131072 },
          reasoning_options: [{ type: 'toggle' }],
        },
      },
    },
    zai: { models: { 'glm-5': { limit: { context: 200000, output: 131072 } } } },
    anthropic: { models: { 'claude-sonnet-5': { limit: { context: 200000, output: 64000 } } } },
  };
  const qwenMatches = plugin.matchModelsDev(api, 'qwen/qwen-max');
  assert.deepEqual(
    qwenMatches.map((m) => m.provider),
    ['alibaba', 'qwen'],
  );
  assert.equal(qwenMatches[0].official, true);
  assert.deepEqual(plugin.matchModelsDev(api, 'qwen-max')[1].reasoningEfforts, [
    'low',
    'medium',
    'high',
  ]);
  const glm = plugin.matchModelsDev(api, 'glm-5.3');
  assert.equal(glm.length, 1);
  assert.equal(glm[0].provider, 'zai');
  assert.equal(glm[0].official, true);
  assert.equal(plugin.matchModelsDev(api, 'claude-sonnet-5')[0].provider, 'anthropic');
  assert.deepEqual(plugin.matchModelsDev(api, 'unknown-model'), []);

  // Name generation matches the newapi behavior this plugin inherits.
  const { modelNameFromId } = plugin;
  assert.equal(modelNameFromId('deepseek-chat'), 'DeepSeek Chat');
  assert.equal(modelNameFromId('zhipu/glm-4-flash'), 'GLM 4 Flash[zhipu]');
  assert.equal(modelNameFromId('openai/gpt-4o'), 'GPT 4o[openai]');
}

// ── Block H: resolveModel honors per-model protocol pinning ──
{
  const adapter = new plugin.CardoAdapter({
    options: () => ({
      baseURL: 'http://gw.local:3000/v1',
      apiKeyRef: 'cardo',
      api: 'chat-completions',
      models: [
        { id: 'chat-model', reasoningEfforts: ['low', 'high'] },
        { id: 'resp-model', api: 'responses' },
      ],
      modelExcludePatterns: [],
      defaultContextWindow: 128_000,
      streamIdleTimeoutMs: 300_000,
      retryPolicy: resolveRetryPolicy(undefined, 'smoke'),
    }),
    resolveApiKey: async () => 'smoke-key',
  });
  const chatResolved = await adapter.resolveModel('cardo', 'chat-model');
  assert.equal(chatResolved.context.contextWindow, 128_000);
  assert.equal(chatResolved.reasoning.defaultEffort, 'high');
  // The response-only model still resolves (wire protocol is not a capability
  // gate here — the adapter routes per request).
  const respResolved = await adapter.resolveModel('cardo', 'resp-model');
  assert.equal(respResolved.context.contextWindow, 128_000);
}

// ── Block I: real-catalog check against the local dev cache (optional) ──
{
  const CACHE = new URL('../.cache/models-dev.api.json', import.meta.url);
  if (!existsSync(CACHE)) {
    console.log(
      'smoke: models.dev dev-cache absent — real-catalog check skipped (pnpm run cache:models-dev to enable)',
    );
  } else {
    const api = JSON.parse(readFileSync(CACHE, 'utf8'));
    const { matchModelsDev } = plugin;
    const gpt = matchModelsDev(api, 'openai/gpt-5.1');
    assert.ok(gpt.length >= 1, 'openai/gpt-5.1 matches the cached catalog');
    assert.ok(
      gpt.some(
        (match) =>
          match.reasoningEfforts?.includes('low') && match.reasoningEfforts.includes('high'),
      ),
      'effort-shaped reasoning_options surface as reasoningEfforts',
    );
    const chat = matchModelsDev(api, 'deepseek/deepseek-chat');
    assert.equal(chat[0].contextWindow, 1_000_000);
    console.log('smoke: models.dev dev-cache check OK (real catalog shapes verified)');
  }
}

console.log(
  'smoke: cardo-provider registrations, dual-protocol serialize/translate, chat-only discovery, credentials key, settings validation, models.dev matching, RPC channel OK',
);
