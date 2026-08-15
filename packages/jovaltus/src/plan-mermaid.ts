/**
 * Plan-mode mermaid rendering (jovaltus) — generated from the execution JSON.
 *
 * The frontend renders the execution graph with mermaid.js, but mermaid text
 * is NEVER parsed from the plan: `planToMermaid` synthesizes the graph from
 * the batch-major structure, so the rendered nodes/edges are always in sync
 * with the JSON that drives dispatch.
 *
 * Output contract (locked by PBT):
 *   header     "flowchart TD"
 *   nodes      one line per agent; batches with >1 agent render as mermaid
 *              `subgraph` blocks, single-agent batches render bare nodes
 *   edges      full connection between consecutive batches: every agent in
 *              batch k → every agent in batch k+1 (serial: linear chain;
 *              parallel: no edges at all)
 *   labels     task_prompt text is quoted and escaped so arbitrary prompts
 *              (quotes, newlines, unicode) never break the graph structure
 */

import type { ExecutionPlan, PlanAgent } from './plan.js';

/** Mermaid-safe HTML-entity escaping for quoted node labels. */
function escapeLabel(text: string): string {
  return text
    .replace(/\\/g, '#bsol;')
    .replace(/"/g, '#quot;')
    .replace(/[\r\n\t]/g, ' ');
}

/**
 * Renders the execution plan as mermaid flowchart source (top-down).
 */
export function planToMermaid(plan: ExecutionPlan): string {
  const lines: string[] = ['flowchart TD'];
  for (const [i, batch] of plan.batches.entries()) {
    const multi = batch.length > 1;
    const batchNo = String(i + 1);
    if (multi) {
      lines.push(`  subgraph B${batchNo}["Batch ${batchNo}"]`);
    }
    for (const agent of batch) {
      lines.push(`${multi ? '    ' : '  '}${nodeDef(agent)}`);
    }
    if (multi) {
      lines.push('  end');
    }
  }
  // full connection between consecutive batches — edges always point forward
  for (let k = 0; k + 1 < plan.batches.length; k++) {
    const left = plan.batches[k];
    const right = plan.batches[k + 1];
    for (const a of left ?? []) {
      for (const b of right ?? []) {
        lines.push(`  ${a.id} --> ${b.id}`);
      }
    }
  }
  return lines.join('\n');
}

function nodeDef(agent: PlanAgent): string {
  return `${agent.id}["${escapeLabel(agent.task_prompt)}"]`;
}
