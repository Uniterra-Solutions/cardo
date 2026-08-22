/**
 * Settings bridge tests (issue #2, FR-2.2/FR-2.4/FR-2.7) against the REAL
 * file-backed settings seam (@deepseek-ai/dsh-settings-file in a temp dir,
 * watch disabled): the browser half talks ONLY to this channel, so namespaces
 * the connection API allowlist would hide (e.g. `memory`) still surface here,
 * redaction is forced on the wire, the seam's own validation and revision
 * guard pass through, and the document affordance materializes the profile
 * settings file for the FR-2.7 notice action. Red until createSettingsBridge
 * is implemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import z from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file';
import { createSettingsBridge } from '../lib/index.js';

const MEMORY_SCHEMA = z.object({
  provider: z.string().min(1).default('deepseek'),
  model: z.string().min(1).default('deepseek-v4-flash'),
  reviewModel: z.string().min(1).default('deepseek-v4-pro'),
  warmupOnStart: z.boolean().default(true),
  maxNodeKb: z.number().min(1).step(1).default(64),
});

const MEMORY_BASE = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  reviewModel: 'deepseek-v4-pro',
  warmupOnStart: true,
  maxNodeKb: 64,
};

const PROVIDER_SCHEMA = z.object({
  api: z.union([z.const('chat-completions'), z.const('responses')]).required(),
  baseURL: z.string().pattern(/^https?:\/\//).default('http://127.0.0.1:3000'),
  apiKey: z.string().role('secret').default(''),
  maxTokens: z.number().min(1).step(1).default(65536),
});

async function makeContext(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'settings-ui-'));
  const file = join(dir, 'settings.yaml');
  const ctx = new Context();
  // cordis 4 starts plugins at registration; awaiting the fiber settles load.
  const fibers = [];
  fibers.push(await ctx.plugin(FileSettingsProvider, { path: file, watch: false }));
  fibers.push(
    await ctx.plugin({
      inject: ['settings'],
      apply: (ctx) => {
        for (const { ns, schema, base } of entries) {
          ctx.settings.register(ns, schema, { base });
        }
      },
    }),
  );
  t.after(async () => {
    for (const fiber of fibers) await fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ctx, file };
}

function bridgeFor(ctx, inventory) {
  return createSettingsBridge(ctx.settings, () => inventory);
}

const INVENTORY = [
  { id: 'llm-uniterra', name: 'uniterra-provider' },
  { id: 'dsh-memory', name: 'dsh-memory' },
  { id: 'dshmarket', name: 'dshmarket' },
];

test('describe covers every registered namespace, including ones the connection API allowlist would hide (FR-2.2)', async (t) => {
  const { ctx } = await makeContext(t, [
    { ns: 'memory', schema: MEMORY_SCHEMA, base: MEMORY_BASE },
    { ns: 'llm-uniterra', schema: PROVIDER_SCHEMA, base: { api: 'responses', baseURL: 'http://127.0.0.1:3000', apiKey: '', maxTokens: 65536 } },
  ]);
  const bridge = bridgeFor(ctx);
  const result = await bridge.handle('describe', {});
  assert.equal(result.ok, true);
  const descriptors = result.value;
  const byNs = new Map(descriptors.map((d) => [d.ns, d]));
  assert.ok(byNs.has('memory'), 'unexposed memory namespace surfaced');
  assert.ok(byNs.has('llm-uniterra'));
  for (const d of descriptors) {
    assert.equal(typeof d.ns, 'string');
    assert.ok(d.schemaJson && typeof d.schemaJson === 'object', 'schemaJson is the toJSON envelope');
    assert.ok(d.schemaJson.refs, 'envelope carries the refs table');
    assert.equal(typeof d.revision, 'number');
    assert.ok(['live', 'restart'].includes(d.applies));
  }
  // The wire must be JSON-safe: schemastery carries meta.pattern as a RegExp,
  // which any JSON transport would flatten to {} — the client's HTML pattern
  // constraint (FR-2.3) would silently vanish. The bridge normalizes it to the
  // source string; in JSON text that surfaces as the unescaped 'https?:' run
  // (the pattern '^https?:\/\/' — the escaped backslashes are transport noise).
  const serialized = JSON.stringify(result.value);
  assert.ok(serialized.includes('https?:'), 'pattern source survives JSON serialization');
});

test('PBT: for any registered namespace set, describe preserves every entry with non-null schema (FR-2.2)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The file-backed seam stores sections in a plain object, so namespaces
  // colliding with Object.prototype keys ('constructor', '__proto__', ...)
  // cannot be registered — fast-check's dangerous-string slices include
  // them, so constrain the arbitrary to namespaces the seam can actually hold.
  // Whitespace-only namespaces are equally unrepresentable (a blank section
  // key neither registers nor round-trips), so exclude those too.
  const registerable = fc
    .string({ minLength: 2, maxLength: 12 })
    .filter((ns) => ns.trim().length > 0 && !(ns in Object.prototype));
  const names = fc.array(registerable, { minLength: 1, maxLength: 6 });
  fc.assert(
    fc.asyncProperty(names, async (nss) => {
      const file = join(dir, `pbt-${Math.random().toString(36).slice(2)}.yaml`);
      const ctx = new Context();
      const fibers = [];
      fibers.push(await ctx.plugin(FileSettingsProvider, { path: file, watch: false }));
      fibers.push(
        await ctx.plugin({
          inject: ['settings'],
          apply: (ctx) => {
            for (const ns of nss) ctx.settings.register(ns, MEMORY_SCHEMA, { base: MEMORY_BASE });
          },
        }),
      );
      try {
        const bridge = bridgeFor(ctx);
        const result = await bridge.handle('describe', {});
        assert.equal(result.ok, true);
        const seen = new Set(result.value.map((d) => d.ns));
        for (const ns of nss) {
          assert.ok(seen.has(ns), `namespace ${ns} preserved`);
        }
        for (const d of result.value) {
          assert.ok(d.schemaJson !== null && d.schemaJson !== undefined);
        }
      } finally {
        for (const fiber of fibers) await fiber.dispose();
        rmSync(file, { force: true });
      }
    }),
    { numRuns: 6 },
  );
});

test('redaction is forced on the wire: secret values never leave the bridge (FR-2.2)', async (t) => {
  const { ctx } = await makeContext(t, [
    { ns: 'llm-uniterra', schema: PROVIDER_SCHEMA, base: { api: 'responses', baseURL: 'http://127.0.0.1:3000', apiKey: 'sk-live-secret-123', maxTokens: 65536 } },
  ]);
  const bridge = bridgeFor(ctx);
  const result = await bridge.handle('describe', { redactSecrets: false });
  assert.equal(result.ok, true);
  const llm = result.value.find((d) => d.ns === 'llm-uniterra');
  assert.equal(llm.value.apiKey, '', 'secret value blanked regardless of the caller asking for no redaction');
  assert.ok(Array.isArray(llm.secrets));
  assert.ok(llm.secrets.includes('apiKey'), 'secret path reported');
});

test('update validates against the schema before persisting; invalid patches refuse with nothing written (FR-2.4)', async (t) => {
  const { ctx, file } = await makeContext(t, [
    { ns: 'llm-uniterra', schema: PROVIDER_SCHEMA, base: { api: 'responses', baseURL: 'http://127.0.0.1:3000', apiKey: '', maxTokens: 65536 } },
  ]);
  const bridge = bridgeFor(ctx);
  // First a valid update so the document exists.
  const valid = await bridge.handle('update', { ns: 'llm-uniterra', patch: { maxTokens: 131072 } });
  assert.equal(valid.ok, true);
  const before = readFileSync(file, 'utf8');
  // Now an invalid patch: unknown enum value.
  const invalid = await bridge.handle('update', { ns: 'llm-uniterra', patch: { api: 'bogus-protocol' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'settings-error');
  const after = readFileSync(file, 'utf8');
  assert.equal(after, before, 'invalid patch never reached the document');
  const describe = await bridge.handle('describe', {});
  const llm = describe.value.find((d) => d.ns === 'llm-uniterra');
  assert.equal(llm.value.maxTokens, 131072);
  assert.equal(llm.value.api, 'responses');
});

test('mutate round-trips path ops through the seam (FR-2.4)', async (t) => {
  const { ctx, file } = await makeContext(t, [
    { ns: 'memory', schema: MEMORY_SCHEMA, base: MEMORY_BASE },
  ]);
  const bridge = bridgeFor(ctx);
  const result = await bridge.handle('mutate', {
    ns: 'memory',
    ops: [
      { op: 'set', path: ['provider'], value: 'uniterra' },
      { op: 'set', path: ['model'], value: 'deepseek-v4-flash' },
    ],
  });
  assert.equal(result.ok, true);
  const describe = await bridge.handle('describe', {});
  const memory = describe.value.find((d) => d.ns === 'memory');
  assert.equal(memory.value.provider, 'uniterra');
  assert.ok(readFileSync(file, 'utf8').includes('provider: uniterra'), 'document persisted the mutation');
});

test('SETTINGS_CONFLICT passes through with its code and revision facts (FR-2.4)', async (t) => {
  const { ctx } = await makeContext(t, [
    { ns: 'memory', schema: MEMORY_SCHEMA, base: MEMORY_BASE },
  ]);
  const bridge = bridgeFor(ctx);
  const first = await bridge.handle('describe', {});
  const revision = first.value.find((d) => d.ns === 'memory').revision;
  const write = await bridge.handle('mutate', { ns: 'memory', ops: [{ op: 'set', path: ['model'], value: 'other' }], expectedRevision: revision });
  assert.equal(write.ok, true);
  // A stale writer holding the old revision is refused by the seam itself.
  const stale = await bridge.handle('mutate', { ns: 'memory', ops: [{ op: 'set', path: ['model'], value: 'stale' }], expectedRevision: revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'SETTINGS_CONFLICT');
  assert.equal(stale.error.details.expected, revision);
  assert.equal(stale.error.details.actual, revision + 1);
  // And the refused write never landed.
  const after = await bridge.handle('describe', {});
  assert.equal(after.value.find((d) => d.ns === 'memory').value.model, 'other');
});

test('document affordance: hasDocument true + openDocument materializes the profile settings file (FR-2.7)', async (t) => {
  const { ctx, file } = await makeContext(t, []);
  const bridge = bridgeFor(ctx);
  const has = await bridge.handle('hasDocument', {});
  assert.deepEqual(has, { ok: true, value: true });
  assert.equal(existsSync(file), false, 'file absent before the open action');
  const open = await bridge.handle('openDocument', {});
  assert.equal(open.ok, true);
  assert.equal(open.value, file, 'prepareDocument returns the resolved path');
  assert.equal(existsSync(file), true, 'absent document materialized');
});

test('inventory + unknown endpoints: host enumeration rides the same channel (FR-2.7/FR-2.2)', async (t) => {
  const { ctx } = await makeContext(t, []);
  const bridge = bridgeFor(ctx, INVENTORY);
  const inventory = await bridge.handle('inventory', {});
  assert.equal(inventory.ok, true);
  assert.deepEqual(inventory.value, INVENTORY);
  const unknown = await bridge.handle('no-such-endpoint', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'unknown-endpoint');
});

test('replace round-trips a wholesale section through the seam (FR-2.4)', async (t) => {
  const { ctx, file } = await makeContext(t, [
    { ns: 'memory', schema: MEMORY_SCHEMA, base: MEMORY_BASE },
  ]);
  const bridge = bridgeFor(ctx);
  const first = await bridge.handle('describe', {});
  const revision = first.value.find((d) => d.ns === 'memory').revision;
  const section = {
    provider: 'uniterra',
    model: 'deepseek-v4-pro',
    reviewModel: 'deepseek-v4-flash',
    warmupOnStart: false,
    maxNodeKb: 128,
  };
  const replaced = await bridge.handle('replace', {
    ns: 'memory',
    section,
    expectedRevision: revision,
  });
  assert.equal(replaced.ok, true);
  // The stored document round-trips valid against the same schema, and the
  // next describe reflects the replaced payload wholesale.
  const after = await bridge.handle('describe', {});
  const memory = after.value.find((d) => d.ns === 'memory');
  assert.equal(memory.value.provider, 'uniterra');
  assert.equal(memory.value.model, 'deepseek-v4-pro');
  assert.equal(memory.value.reviewModel, 'deepseek-v4-flash');
  assert.equal(memory.value.warmupOnStart, false);
  assert.equal(memory.value.maxNodeKb, 128);
  assert.ok(readFileSync(file, 'utf8').includes('provider: uniterra'), 'replaced section persisted');
});

test('external document edits re-describe once the provider watch settles (FR-2.7)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-ui-'));
  const file = join(dir, 'settings.yaml');
  const ctx = new Context();
  const fibers = [];
  fibers.push(await ctx.plugin(FileSettingsProvider, { path: file, watch: true }));
  fibers.push(
    await ctx.plugin({
      inject: ['settings'],
      apply: (ctx) => {
        ctx.settings.register('memory', MEMORY_SCHEMA, { base: MEMORY_BASE });
      },
    }),
  );
  t.after(async () => {
    for (const fiber of fibers) await fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const bridge = bridgeFor(ctx);
  const write = await bridge.handle('mutate', {
    ns: 'memory',
    ops: [{ op: 'set', path: ['model'], value: 'wired-model' }],
  });
  assert.equal(write.ok, true);
  assert.ok(readFileSync(file, 'utf8').includes('wired-model'), 'document exists with the wired value');
  // A user editing the profile document directly — exactly what the FR-2.7
  // open-profile-settings-document action surfaces the file for.
  const edited = readFileSync(file, 'utf8').replace('wired-model', 'external-edit');
  writeFileSync(file, edited);
  // Let the provider's watcher debounce (chokidar stability threshold) settle.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = await bridge.handle('describe', {});
  assert.equal(
    after.value.find((d) => d.ns === 'memory').value.model,
    'external-edit',
    'describe reflects the external file edit',
  );
});
