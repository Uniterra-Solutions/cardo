/**
 * PBT spec — mermaid rendering of the execution plan (`dist/plan-mermaid.js`).
 *
 * The frontend renders the execute-panel graph with mermaid.js; the source is
 * GENERATED from the batch-major JSON, never parsed from free text, so the
 * picture always matches dispatch. Business invariants:
 *  1. Total: any valid plan renders without throwing.
 *  2. Header: output is a `flowchart TD` diagram.
 *  3. Structure (exact line accounting): 1 header + 2 lines per multi-agent
 *     subgraph + 1 node line per agent + 1 line per edge — labels may never
 *     smuggle in extra lines (escaping must hold even for hostile prompts).
 *  4. Node defs: exactly one per agent, ids matching the plan's id set.
 *  5. Edges are forward-only and exhaustive between consecutive batches:
 *     |batch k| × |batch k+1| arrows; serial → linear chain; parallel → none.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { planToMermaid } from '../../dist/plan-mermaid.js';
import {
  anyPlanArb,
  batchIndexOf,
  batchedPlanArb,
  hostileAnyPlanArb,
  parallelPlanArb,
  planAgentIds,
  serialPlanArb,
} from '../helpers/plan-gen.mts';

const NODE_DEF = /^\s*[A-Za-z0-9_-]+\["/;
const EDGE_LINE = /^\s*([A-Za-z0-9_-]+)\s+-->\s+([A-Za-z0-9_-]+)\s*$/;

/** Exact line budget for a plan (1 header, 2 per multi-agent subgraph, 1 per agent, 1 per edge). */
function expectedLineCount(plan: Parameters<typeof planToMermaid>[0]): number {
  const subgraphs = plan.batches.filter((b) => b.length > 1).length;
  let edges = 0;
  for (let k = 0; k + 1 < plan.batches.length; k++) {
    const left = plan.batches[k];
    const right = plan.batches[k + 1];
    edges += (left?.length ?? 0) * (right?.length ?? 0);
  }
  return 1 + 2 * subgraphs + plan.batches.flat().length + edges;
}

function assertDiagramStructure(plan: Parameters<typeof planToMermaid>[0], source: string): void {
  const lines = source.split('\n');
  assert.equal(source.startsWith('flowchart TD'), true, 'must be a flowchart TD');
  assert.equal(lines.length, expectedLineCount(plan), `line budget violated:\n${source}`);

  const nodeDefs = lines.filter((l) => NODE_DEF.test(l));
  const nodeIds = new Set(nodeDefs.map((l) => l.trim().split('[')[0] ?? ''));
  assert.equal(nodeDefs.length, plan.batches.flat().length, `one node per agent:\n${source}`);
  assert.deepEqual(nodeIds, new Set(planAgentIds(plan)), `node ids match the plan:\n${source}`);

  const batchOf = batchIndexOf(plan);
  const edges = lines.filter((l) => EDGE_LINE.test(l));
  for (const edge of edges) {
    const [, from, to] = EDGE_LINE.exec(edge) ?? [];
    const fromIdx = from !== undefined ? batchOf.get(from) : undefined;
    const toIdx = to !== undefined ? batchOf.get(to) : undefined;
    assert.notEqual(fromIdx, undefined, `edge source ${from} must be a plan agent`);
    assert.notEqual(toIdx, undefined, `edge target ${to} must be a plan agent`);
    assert.ok((fromIdx ?? -1) < (toIdx ?? -2), `edges are forward-only (${from} --> ${to})`);
  }
}

test('total: any valid plan renders without throwing', async () => {
  await fc.assert(
    fc.property(anyPlanArb, (plan) => {
      assert.doesNotThrow(() => planToMermaid(plan));
    }),
  );
});

test('structure: exact line budget, one node per agent, forward-only exhaustive edges', async () => {
  await fc.assert(
    fc.property(batchedPlanArb, (plan) => {
      assertDiagramStructure(plan, planToMermaid(plan));
    }),
  );
  await fc.assert(
    fc.property(serialPlanArb, (plan) => {
      const source = planToMermaid(plan);
      assertDiagramStructure(plan, source);
      const n = planAgentIds(plan).length;
      assert.equal((source.match(/-->/g) ?? []).length, n - 1, 'serial renders a linear chain');
    }),
  );
  await fc.assert(
    fc.property(parallelPlanArb, (plan) => {
      const source = planToMermaid(plan);
      assertDiagramStructure(plan, source);
      assert.equal((source.match(/-->/g) ?? []).length, 0, 'parallel renders no edges');
    }),
  );
});

test('escaping: hostile task prompts never break the graph structure', async () => {
  await fc.assert(
    fc.property(hostileAnyPlanArb, (plan) => {
      const source = planToMermaid(plan);
      assertDiagramStructure(plan, source);
    }),
  );
});
