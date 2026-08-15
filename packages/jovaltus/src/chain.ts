/**
 * Jovaltus phase chains and verdict handling (pi-agent port).
 *
 * Ported from the Hermes plugin's CHAIN table (`src/jovaltus/tools.py`) and
 * verdict readers (`src/jovaltus/hooks.py`).
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { PipelineState } from './state.js';

/**
 * Contract chain table: phase -> next phase. The simplify/review reviewer
 * legs are verdict-driven (readers read verdict.json before following the
 * "simplify" -> "simplify_waiting" / "review" -> "review_waiting" edges).
 * The waiting phases dispatch NO subagent: the main agent performs the fixes
 * itself, and the `agent_settled` event re-dispatches the reviewer once the
 * main agent's fixing turn ends.
 */
export const CHAIN: Record<string, Record<string, string>> = {
  plan: {
    prd: 'design',
    design: 'plan_waiting',
  },
  execute: { execute: 'done' },
  simplify: { simplify: 'simplify_waiting', simplify_waiting: 'simplify' },
  review: { review: 'review_waiting', review_waiting: 'review' },
};

/**
 * Phases where the pipeline waits for OUT-OF-BAND work: the main agent
 * writes the execution plan JSON (plan_waiting — advanced by `agent_settled`
 * once the artifact parses), or applies reviewer fixes (simplify/review).
 */
export const WAITING_PHASES: readonly string[] = [
  'plan_waiting',
  'simplify_waiting',
  'review_waiting',
];

/** The parking phase for a reviewer's "fix" verdict (no subagent runs). */
export function waitingPhase(tool: string): string {
  if (tool === 'simplify') {
    return 'simplify_waiting';
  }
  if (tool === 'review') {
    return 'review_waiting';
  }
  throw new Error(`no waiting phase for tool ${tool}`);
}

/**
 * Read `<run_dir>/verdict.json` -> "pass" | "fix". Returns null when the
 * file is missing, unparsable, or holds an invalid verdict — callers fail
 * the pipeline deterministically.
 */
export function readVerdict(p: PipelineState): string | null {
  const verdictFile = path.join(p.run_dir, 'verdict.json');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(verdictFile, 'utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const verdict = (data as Record<string, unknown>)['verdict'];
  if (verdict !== 'pass' && verdict !== 'fix') {
    return null;
  }
  return verdict;
}

/**
 * The reviewer's `findings` text from verdict.json, or "" when unavailable.
 */
export function readFindings(p: PipelineState): string {
  const verdictFile = path.join(p.run_dir, 'verdict.json');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(verdictFile, 'utf8'));
  } catch {
    return '';
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return '';
  }
  const findings = (data as Record<string, unknown>)['findings'];
  return typeof findings === 'string' ? findings : '';
}
