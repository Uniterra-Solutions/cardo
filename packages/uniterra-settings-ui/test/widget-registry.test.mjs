/**
 * Widget registry tests (issue #2, FR-2.5): feature plugins register bespoke
 * controls for a namespace field (model catalog, write-only API-key virtual
 * widget, models.dev params panel) and the generic renderer falls back to the
 * schema-driven control when nothing is registered. Red until
 * createSettingsWidgetRegistry is implemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import z from '@deepseek-ai/schemastery';
import { collectFieldPaths, createSettingsWidgetRegistry, toFieldTree } from '../lib/index.js';

const MODEL_CATALOG = { id: 'model-catalog', component: 'ModelCatalog' };
const API_KEY_WIDGET = { id: 'api-key', component: 'ApiKey' };
const PARAMS_PANEL = { id: 'models-dev-params', component: 'ModelsDevParams' };

test('resolve: exact match wins, then longest ancestor prefix, then undefined (FR-2.5)', () => {
  const registry = createSettingsWidgetRegistry();
  registry.register('llm-uniterra', 'models', MODEL_CATALOG);
  registry.register('llm-uniterra', 'apiKey', API_KEY_WIDGET);
  registry.register('llm-uniterra', 'models.dev', PARAMS_PANEL);

  assert.equal(registry.resolve('llm-uniterra', 'models'), MODEL_CATALOG);
  assert.equal(registry.resolve('llm-uniterra', 'apiKey'), API_KEY_WIDGET);
  // Array items inherit the array-level widget (exact, then longest prefix).
  assert.equal(registry.resolve('llm-uniterra', 'models.0'), MODEL_CATALOG);
  assert.equal(registry.resolve('llm-uniterra', 'models.dev.params'), PARAMS_PANEL);
  // Unregistered nested plain object falls back to the generic object editor.
  assert.equal(registry.resolve('llm-uniterra', 'proxy'), undefined);
  assert.equal(registry.resolve('llm-uniterra', 'proxy.enabled'), undefined);
  // Namespace isolation: registrations never leak across namespaces.
  assert.equal(registry.resolve('memory', 'models'), undefined);
  assert.equal(registry.resolve('other', 'apiKey'), undefined);
});

test('registration is last-write-wins (FR-2.5 override)', () => {
  const registry = createSettingsWidgetRegistry();
  registry.register('llm-uniterra', 'models', MODEL_CATALOG);
  registry.register('llm-uniterra', 'models', PARAMS_PANEL);
  assert.equal(registry.resolve('llm-uniterra', 'models'), PARAMS_PANEL);
});

test('list returns every registration in order (FR-2.5)', () => {
  const registry = createSettingsWidgetRegistry();
  registry.register('llm-uniterra', 'models', MODEL_CATALOG);
  registry.register('llm-uniterra', 'apiKey', API_KEY_WIDGET);
  const listed = registry.list('llm-uniterra');
  assert.deepEqual(
    listed.map((entry) => [entry.fieldPath, entry.widget.id]),
    [
      ['models', 'model-catalog'],
      ['apiKey', 'api-key'],
    ],
  );
  assert.deepEqual(registry.list('memory'), []);
});

test('PBT: resolve never throws and returns undefined for unregistered paths (FR-2.5)', () => {
  const registry = createSettingsWidgetRegistry();
  registry.register('llm-uniterra', 'models', MODEL_CATALOG);
  registry.register('llm-uniterra', 'apiKey', API_KEY_WIDGET);
  const known = new Map([
    ['models', MODEL_CATALOG],
    ['apiKey', API_KEY_WIDGET],
  ]);
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      (ns, path) => {
        const widget = registry.resolve(ns, path);
        if (ns === 'llm-uniterra' && known.has(path)) {
          assert.equal(widget, known.get(path));
        } else {
          assert.equal(widget, undefined);
        }
      },
    ),
  );
});

test('virtual widgets are exactly the registrations whose path is not a schema field path (FR-2.5)', () => {
  // The provider Config has NO apiKey field (PRD FR-2.4), so a registry entry
  // at 'apiKey' renders as a namespace-level virtual panel, while 'models' is
  // a schema field and renders as a field override.
  const schema = z.object({
    baseURL: z.string().default('http://127.0.0.1:3000'),
    models: z.array(z.object({ id: z.string().required() })).default([]),
  });
  const tree = toFieldTree(schema.toJSON(), schema.toJSON().refs);
  const registry = createSettingsWidgetRegistry();
  registry.register('llm-uniterra', 'models', MODEL_CATALOG);
  registry.register('llm-uniterra', 'apiKey', API_KEY_WIDGET);
  const nodePaths = collectFieldPaths(tree);
  const virtuals = registry
    .list('llm-uniterra')
    .filter((entry) => !nodePaths.has(entry.fieldPath));
  assert.deepEqual(virtuals.map((entry) => entry.fieldPath), ['apiKey']);
});

test('PBT: the virtual/field split is total over the registrations (FR-2.5)', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom('baseURL', 'apiKey', 'models', 'proxy.enabled')), (paths) => {
      const schema = z.object({
        baseURL: z.string().default('http://127.0.0.1:3000'),
        models: z.array(z.object({ id: z.string().required() })).default([]),
      });
      const tree = toFieldTree(schema.toJSON(), schema.toJSON().refs);
      const nodePaths = collectFieldPaths(tree);
      const registry = createSettingsWidgetRegistry();
      for (const path of paths) registry.register('llm-uniterra', path, MODEL_CATALOG);
      const listed = registry.list('llm-uniterra').map((entry) => entry.fieldPath);
      for (const path of listed) {
        assert.equal(
          nodePaths.has(path),
          paths.includes(path) && ['baseURL', 'models'].includes(path),
          'split must agree with the schema field set',
        );
      }
    }),
  );
});
