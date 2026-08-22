/**
 * Field-tree mapper tests (issue #2, FR-2.3): the generic renderer's pure
 * schema → control-tree mapping. Fixtures mirror the provider's real config
 * shapes (union-of-const api, pattern-string baseURL, secret apiKey, nested
 * proxy, empty-child providerHints records, array of models, union-of-object
 * retryPolicy). Red until toFieldTree is implemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import z from '@deepseek-ai/schemastery';
import { collectFieldPaths, toFieldTree } from '../lib/index.js';

/** Provider-shaped config fixture (issue #2's auto-render target). */
const CONFIG_FIXTURE = z.object({
  api: z.union([z.const('chat-completions'), z.const('responses')]).required(),
  baseURL: z.string().pattern(/^https?:\/\//).default('http://127.0.0.1:3000'),
  apiKey: z.string().role('secret').default(''),
  models: z
    .array(
      z.object({
        id: z.string().required(),
        displayName: z.string(),
      }),
    )
    .default([]),
  proxy: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default('http://127.0.0.1:7890'),
  }),
  providerHints: z.object({
    defaults: z.object({}),
    models: z.object({}),
  }),
  retryPolicy: z.union([
    z.object({ mode: z.const('normal'), maxRetries: z.number().min(0).max(10).default(2) }),
    z.object({ mode: z.const('always') }),
  ]),
  enabled: z.boolean().default(true),
  maxTokens: z.number().min(1).max(1048576).step(1),
});

function byPath(nodes, path) {
  for (const node of nodes) {
    if (node.fieldPath === path) return node;
    if (node.children) {
      const hit = byPath(node.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

test('toFieldTree renders every provider-shaped control (FR-2.3)', () => {
  const schemaJson = CONFIG_FIXTURE.toJSON();
  const value = {
    api: 'chat-completions',
    baseURL: 'http://127.0.0.1:3000',
    apiKey: '',
    models: [],
    proxy: { enabled: false, url: 'http://127.0.0.1:7890' },
    providerHints: { defaults: {}, models: {} },
    retryPolicy: { mode: 'normal', maxRetries: 2 },
    enabled: true,
    maxTokens: 65536,
  };
  const tree = toFieldTree(schemaJson, value);
  const api = byPath(tree, 'api');
  assert.ok(api, 'api field mapped');
  assert.equal(api.type, 'select');
  assert.deepEqual(api.choices, ['chat-completions', 'responses']);

  const baseURL = byPath(tree, 'baseURL');
  assert.equal(baseURL.type, 'text');
  // The pattern field carries the regex source (FieldNode.pattern doc);
  // it must compile and accept the default URL (FR-2.3 pattern validation).
  assert.match('http://127.0.0.1:3000', new RegExp(baseURL.pattern));
  assert.equal(baseURL.default, 'http://127.0.0.1:3000');

  const apiKey = byPath(tree, 'apiKey');
  assert.equal(apiKey.type, 'text');
  assert.equal(apiKey.secret, true);

  const models = byPath(tree, 'models');
  assert.equal(models.type, 'array');
  assert.equal(models.children[0].type, 'object');
  assert.ok(byPath(models.children, 'models.*.id'), 'array element field mapped');
  assert.ok(byPath(models.children, 'models.*.displayName'));

  const proxy = byPath(tree, 'proxy');
  assert.equal(proxy.type, 'object');
  assert.equal(byPath(tree, 'proxy.enabled').type, 'boolean');
  assert.equal(byPath(tree, 'proxy.url').type, 'text');

  const enabled = byPath(tree, 'enabled');
  assert.equal(enabled.type, 'boolean');
  assert.equal(enabled.default, true);

  const maxTokens = byPath(tree, 'maxTokens');
  assert.equal(maxTokens.type, 'number');
  assert.equal(maxTokens.min, 1);
  assert.equal(maxTokens.max, 1048576);
  assert.equal(maxTokens.step, 1);
});

test('toFieldTree maps empty-child records to a key-value dict editor (FR-2.3 providerHints)', () => {
  const tree = toFieldTree(CONFIG_FIXTURE.toJSON(), CONFIG_FIXTURE.toJSON().refs);
  const hints = byPath(tree, 'providerHints');
  assert.equal(hints.type, 'object');
  assert.equal(byPath(tree, 'providerHints.defaults').type, 'dict');
  assert.equal(byPath(tree, 'providerHints.models').type, 'dict');
});

test('toFieldTree maps union-of-object variants to a variant select (FR-2.3 retryPolicy)', () => {
  const tree = toFieldTree(CONFIG_FIXTURE.toJSON(), CONFIG_FIXTURE.toJSON().refs);
  const retry = byPath(tree, 'retryPolicy');
  assert.equal(retry.type, 'select');
  assert.equal(retry.discriminator, 'mode');
  assert.deepEqual(retry.choices, ['normal', 'always']);
  const normal = byPath(tree, 'retryPolicy.normal');
  assert.ok(normal, 'variant subtree present');
  assert.equal(normal.type, 'object');
  assert.equal(byPath(tree, 'retryPolicy.normal.maxRetries').type, 'number');
  assert.equal(byPath(tree, 'retryPolicy.always').type, 'object');
});

test('toFieldTree never throws on an unknown schema type; it degrades to readonly', () => {
  // Hand-built envelope with an unrecognized ref type (simulates a future
  // schemastery feature the renderer has not seen yet).
  const envelope = { uid: 1, refs: { '1': { type: 'object', meta: {}, dict: { weird: 2 } }, '2': { type: 'wat', meta: {} } } };
  const tree = toFieldTree(envelope, { weird: 'x' });
  const weird = byPath(tree, 'weird');
  assert.ok(weird, 'unknown field still surfaces');
  assert.equal(weird.type, 'readonly');
});

test('toFieldTree accepts a string pattern (the JSON-safe wire form) and it validates the value (FR-2.3)', () => {
  // Hand-built envelope mirroring what the bridge serves after toJsonSafe
  // normalizes the schemastery RegExp to its source string.
  const envelope = {
    uid: 1,
    refs: {
      '1': { type: 'object', meta: {}, dict: { url: 2 } },
      '2': { type: 'string', meta: { pattern: '^https?:\\/\\/' } },
    },
  };
  const tree = toFieldTree(envelope, { url: 'http://127.0.0.1:3000' });
  const url = byPath(tree, 'url');
  assert.ok(url, 'patterned field mapped');
  assert.equal(url.type, 'text');
  assert.equal(url.pattern, '^https?:\\/\\/');
  assert.match('http://127.0.0.1:3000', new RegExp(url.pattern), 'pattern accepts the default URL');
  assert.doesNotMatch('ftp://nope', new RegExp(url.pattern), 'pattern rejects a non-http URL');
});

test('PBT: arbitrary schema envelopes map without throwing, node types stay in the closed set (FR-2.3)', () => {
  const refArb = fc.oneof(
    fc.constant({ type: 'string', meta: {} }),
    fc.constant({ type: 'string', meta: { role: 'secret', required: true } }),
    fc.constant({ type: 'number', meta: { min: 0, max: 10, step: 1, default: 1 } }),
    fc.constant({ type: 'boolean', meta: { default: false } }),
    fc.constant({ type: 'const', meta: {}, value: 'x' }),
    fc.constant({ type: 'union', meta: {}, list: [10, 11] }),
    fc.constant({ type: 'array', meta: {}, inner: 12 }),
    fc.constant({ type: 'object', meta: {}, dict: {} }),
    fc.constant({ type: 'object', meta: {}, dict: { a: 13, b: 14 } }),
    fc.constant({ type: 'dict', meta: {}, inner: 15, sKey: 16 }),
    fc.constant({ type: 'unknown-future-type', meta: {} }),
  );
  const envelopeArb = fc.record({
    uid: fc.integer({ min: 1, max: 100 }),
    refs: fc.dictionary(fc.string(), refArb),
  });
  const closedSet = new Set(['text', 'number', 'boolean', 'select', 'object', 'array', 'dict', 'readonly']);
  fc.assert(
    fc.property(envelopeArb, (envelope) => {
      const tree = toFieldTree(envelope, {});
      assert.ok(Array.isArray(tree));
      const walk = (nodes) => {
        for (const node of nodes) {
          assert.equal(typeof node.fieldPath, 'string');
          assert.ok(closedSet.has(node.type), `node type ${node.type} outside closed set`);
          if (node.children) walk(node.children);
        }
      };
      walk(tree);
    }),
  );
});

test('collectFieldPaths covers every rendered node path, including container children (FR-2.5)', () => {
  const tree = toFieldTree(CONFIG_FIXTURE.toJSON(), CONFIG_FIXTURE.toJSON().refs);
  const paths = collectFieldPaths(tree);
  const expected = ['api', 'baseURL', 'apiKey', 'models', 'models.*', 'models.*.id', 'models.*.displayName', 'proxy', 'proxy.enabled', 'proxy.url', 'providerHints', 'providerHints.defaults', 'providerHints.models', 'retryPolicy', 'retryPolicy.normal', 'retryPolicy.normal.maxRetries', 'retryPolicy.always', 'enabled', 'maxTokens'];
  for (const path of expected) {
    assert.ok(paths.has(path), 'missing ' + path);
  }
  assert.equal(paths.size, expected.length, 'exactly the rendered paths, no extras');
});

test('collectFieldPaths feeds the FR-2.5 virtual-widget filter: the write-only API key is not a schema field', () => {
  // The provider Config deliberately has NO apiKey field (PRD FR-2.4): the
  // key persists through api.credentials (ref "uniterra") via its widget.
  const schema = z.object({
    baseURL: z.string().default('http://127.0.0.1:3000'),
    models: z.array(z.object({ id: z.string().required() })).default([]),
  });
  const tree = toFieldTree(schema.toJSON(), schema.toJSON().refs);
  const paths = collectFieldPaths(tree);
  assert.equal(paths.has('baseURL'), true);
  assert.equal(paths.has('models'), true);
  assert.equal(paths.has('models.*'), true);
  assert.equal(paths.has('models.*.id'), true);
  assert.equal(paths.has('apiKey'), false, 'apiKey is a namespace-level virtual widget, not a schema field');
});
