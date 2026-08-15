/**
 * Plan-mode artifact IO (jovaltus) — run-dir files the pipeline produces and
 * consumes. The plan pipeline writes `prd.md` / `design.md` / `clarify.md`
 * and the main agent writes `execution-plan.json`; `execute_plan` reads the
 * JSON and auto-injects the PRD + design docs into every dispatched agent.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseExecutionPlan, type ExecutionPlan } from './plan.js';

export const EXECUTION_PLAN_FILENAME = 'execution-plan.json';
export const PRD_FILENAME = 'prd.md';
export const DESIGN_FILENAME = 'design.md';
export const CLARIFY_FILENAME = 'clarify.md';

/**
 * Read + validate the execution plan artifact from a run dir. Total: missing
 * or unparsable files yield null, never throw.
 */
export function readExecutionPlan(runDir: string): ExecutionPlan | null {
  try {
    const data: unknown = JSON.parse(
      readFileSync(path.join(runDir, EXECUTION_PLAN_FILENAME), 'utf8'),
    );
    return parseExecutionPlan(data);
  } catch {
    return null;
  }
}

/** Read a run-dir doc file, or '' when absent. */
export function readRunDoc(runDir: string, filename: string): string {
  try {
    return readFileSync(path.join(runDir, filename), 'utf8');
  } catch {
    return '';
  }
}

/**
 * PRD + design doc (+ clarification note) concatenated — the context that is
 * auto-injected into every agent dispatched by `execute_plan`, so task
 * prompts can stay self-contained instructions.
 */
export function readPlanContext(runDir: string): string {
  const docs: Array<[string, string]> = [
    ['PRD', readRunDoc(runDir, PRD_FILENAME)],
    ['Design doc', readRunDoc(runDir, DESIGN_FILENAME)],
    ['Requirements clarification', readRunDoc(runDir, CLARIFY_FILENAME)],
  ];
  return docs
    .filter(([, text]) => text.trim().length > 0)
    .map(([name, text]) => `## ${name}\n${text}`)
    .join('\n\n');
}
