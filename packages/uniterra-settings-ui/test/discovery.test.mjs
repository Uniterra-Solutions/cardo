/**
 * Extension discovery split tests (issue #2, FR-2.2 + FR-2.7): the settings
 * page lists installed extensions; one exposing a descriptor-backed namespace
 * renders generically, one exposing none gets the read-only notice. Red until
 * selectNamespaces is implemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { selectNamespaces } from '../lib/index.js';

const INVENTORY = [
  { id: 'llm-uniterra', name: 'uniterra-provider' },
  { id: 'dsh-memory', name: 'dsh-memory' },
  { id: 'dshmarket', name: 'dshmarket' },
];

const DESCRIPTORS = [
  { ns: 'llm-uniterra', schemaJson: { uid: 1, refs: { '1': { type: 'object', meta: {}, dict: {} } } } },
  { ns: 'memory', schemaJson: { uid: 2, refs: { '2': { type: 'object', meta: {}, dict: {} } } } },
];

const OWNER_MAP = { 'dsh-memory': ['memory'] };

test('selectNamespaces splits the inventory by descriptor ownership (FR-2.7)', () => {
  const split = selectNamespaces(INVENTORY, DESCRIPTORS, OWNER_MAP);
  const withIds = split.withSettings.map((entry) => entry.extension.id).sort();
  assert.deepEqual(withIds, ['dsh-memory', 'llm-uniterra']);
  assert.deepEqual(
    split.withoutSettings.map((entry) => entry.id),
    ['dshmarket'],
  );
  // Each withSettings entry carries exactly the descriptors it owns.
  const memory = split.withSettings.find((entry) => entry.extension.id === 'dsh-memory');
  assert.deepEqual(memory.namespaces.map((d) => d.ns), ['memory']);
  const llm = split.withSettings.find((entry) => entry.extension.id === 'llm-uniterra');
  assert.deepEqual(llm.namespaces.map((d) => d.ns), ['llm-uniterra']);
});

test('identity convention: ns === extension id owns by default; dsh-memory needs its curated entry (FR-2.7)', () => {
  const withoutOwnerMap = selectNamespaces(INVENTORY, DESCRIPTORS);
  // 'memory' ≠ 'dsh-memory': without the curated map the memory namespace is
  // orphaned and dsh-memory falls into the notice list.
  assert.deepEqual(
    withoutOwnerMap.withoutSettings.map((entry) => entry.id).sort(),
    ['dsh-memory', 'dshmarket'],
  );
  assert.deepEqual(
    withoutOwnerMap.withSettings.map((entry) => entry.extension.id),
    ['llm-uniterra'],
  );
});

test('an owner never leaks into withSettings without a backing descriptor (FR-2.7)', () => {
  const orphaned = selectNamespaces(
    [{ id: 'dsh-memory', name: 'dsh-memory' }],
    [{ ns: 'llm-uniterra', schemaJson: {} }],
    { 'dsh-memory': ['memory'] },
  );
  assert.deepEqual(orphaned.withSettings, []);
  assert.deepEqual(orphaned.withoutSettings.map((entry) => entry.id), ['dsh-memory']);
});

test('PBT: every extension lands in exactly one list; the union is the inventory (FR-2.2)', () => {
  const extensionArb = fc.record({ id: fc.string({ minLength: 1 }), name: fc.string({ minLength: 1 }) });
  const descriptorArb = fc.record({ ns: fc.string({ minLength: 1 }), schemaJson: fc.constant({}) });
  fc.assert(
    fc.property(
      // The inventory must carry unique ids: the split union/disjointness
      // properties count every extension exactly once.
      fc.uniqueArray(extensionArb, { maxLength: 8, selector: (e) => e.id }),
      fc.array(descriptorArb, { maxLength: 8 }),
      (inventory, descriptors) => {
        const split = selectNamespaces(inventory, descriptors);
        const withIds = split.withSettings.map((entry) => entry.extension.id);
        const withoutIds = split.withoutSettings.map((entry) => entry.id);
        // No duplicates in either list.
        assert.equal(new Set(withIds).size, withIds.length);
        assert.equal(new Set(withoutIds).size, withoutIds.length);
        // Disjoint, and their union is exactly the inventory.
        const union = new Set([...withIds, ...withoutIds]);
        assert.equal(union.size, withIds.length + withoutIds.length);
        assert.deepEqual([...union].sort(), inventory.map((entry) => entry.id).sort());
        // Identity ownership rule: an extension is in withSettings exactly
        // when some descriptor ns equals its id.
        const nsSet = new Set(descriptors.map((d) => d.ns));
        for (const entry of inventory) {
          const expected = nsSet.has(entry.id);
          assert.equal(
            withIds.includes(entry.id),
            expected,
            `extension ${entry.id} ownership mismatch`,
          );
          assert.equal(withoutIds.includes(entry.id), !expected);
        }
        // withSettings descriptors are drawn from the input descriptors.
        for (const entry of split.withSettings) {
          for (const d of entry.namespaces) {
            assert.ok(descriptors.some((input) => input.ns === d.ns));
          }
        }
      },
    ),
  );
});
