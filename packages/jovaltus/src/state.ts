/**
 * Jovaltus deterministic pipeline state machine (pi-agent port).
 *
 * Ported from the Hermes plugin's `src/jovaltus/state.py`. State is
 * persisted to `<agentDir>/jovaltus.json` under the top-level "pipeline"
 * key; `agentDir` is pi's config dir (`~/.pi/agent` by default, resolved
 * via `getAgentDir()`).
 *
 * The state machine is deliberately dumb: it records transitions and
 * persists them. Deciding *which* transition to take lives in the tool
 * handlers and the `agent_settled` event (this module never imports pi
 * APIs — stdlib + `getAgentDir` only).
 */

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const PLUGIN_NAME = 'jovaltus';
const PIPELINE_KEY = 'pipeline';

export const PHASES: readonly string[] = [
  'prd',
  'research',
  'acceptance',
  'tasks',
  'execute',
  'simplify',
  'simplify_waiting',
  'review',
  'review_waiting',
] as const;

export const STATUSES: readonly string[] = ['idle', 'running', 'done', 'failed'] as const;

// First phase of each tool's chain.
const FIRST_PHASE: Record<string, string> = {
  plan: 'prd',
  execute: 'execute',
  simplify: 'simplify',
  review: 'review',
};

// set_phase() additionally accepts the terminal "done" phase.
const VALID_PHASES: readonly string[] = [...PHASES, 'done'];

const VALID_VERDICTS: readonly string[] = ['pass', 'fix'];

export interface PipelineState {
  /** abs path to <repo_root>/.plan/<YYYYmmdd>/<plan_name>/ */
  run_dir: string;
  /** "plan" | "execute" | "simplify" | "review" */
  tool: string;
  /** one of PHASES (or "done") */
  phase: string;
  /** one of STATUSES */
  status: string;
  user_requirements: string;
  /** required for execute; optional for simplify/review */
  plan_path: string | null;
  /** simplify/review loop counter (no cap) */
  loop_iteration: number;
  /** "pass" | "fix" | null */
  verdict: string | null;
  /** ISO timestamp */
  updated_at: string;
  error: string | null;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined ? '' : JSON.stringify(value);
}

function now(): string {
  return new Date().toISOString();
}

function stateFilePath(): string {
  return path.join(getAgentDir(), `${PLUGIN_NAME}.json`);
}

function loadRaw(): Record<string, unknown> {
  try {
    const text = readFileSync(stateFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Missing or corrupt file: treat as empty state.
    return {};
  }
}

function persist(p: PipelineState): void {
  const state = loadRaw();
  state[PIPELINE_KEY] = p;
  try {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Best-effort persistence: a read-only agent dir must not crash the
    // pipeline — state still lives in the in-memory object for the run.
  }
}

function fromDict(data: Record<string, unknown>): PipelineState | null {
  if (typeof data['run_dir'] !== 'string' || typeof data['tool'] !== 'string') {
    return null;
  }
  return {
    run_dir: stringField(data, 'run_dir'),
    tool: stringField(data, 'tool'),
    phase: stringField(data, 'phase'),
    status: stringField(data, 'status'),
    user_requirements: stringField(data, 'user_requirements'),
    plan_path: optionalString(data['plan_path']),
    loop_iteration: Number(data['loop_iteration'] ?? 0),
    verdict: optionalString(data['verdict']),
    updated_at: stringField(data, 'updated_at'),
    error: optionalString(data['error']),
  };
}

/**
 * Return the persisted pipeline, or null when idle. Always reads from disk,
 * so an interrupted pipeline resumes across sessions and process boundaries.
 * A pipeline whose phase is unknown (corrupted state) is auto-cleared so it
 * can never deadlock the chain with a KeyError.
 */
export function getPipeline(): PipelineState | null {
  const raw = loadRaw()[PIPELINE_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const p = fromDict(raw as Record<string, unknown>);
  if (p === null) {
    resetPipeline();
    return null;
  }
  if (!VALID_PHASES.includes(p.phase)) {
    resetPipeline();
    return null;
  }
  // The tool field is written only by startPipeline; an unknown tool means
  // the state file was corrupted or hand-edited. Like an unknown phase, it
  // is auto-cleared so agent_settled can never silently "complete" a
  // pipeline whose chain does not exist.
  if (!Object.keys(FIRST_PHASE).includes(p.tool)) {
    resetPipeline();
    return null;
  }
  return p;
}

/**
 * Start (or overwrite) a pipeline run for `tool`. The new pipeline begins in
 * the tool's first phase with status "running".
 */
export function startPipeline(
  tool: string,
  runDir: string,
  userRequirements = '',
  planPath: string | null = null,
): PipelineState {
  const firstPhase = FIRST_PHASE[tool];
  if (firstPhase === undefined) {
    throw new Error(`unknown pipeline tool: ${tool}`);
  }
  const p: PipelineState = {
    run_dir: runDir,
    tool,
    phase: firstPhase,
    status: 'running',
    user_requirements: userRequirements,
    plan_path: planPath,
    loop_iteration: 0,
    verdict: null,
    updated_at: now(),
    error: null,
  };
  persist(p);
  return p;
}

function ensureRunning(p: PipelineState, what = 'mutate'): void {
  if (p.status === 'done' || p.status === 'failed') {
    throw new Error(`cannot ${what} a finished pipeline (status=${p.status})`);
  }
}

/** Record a phase transition and persist. */
export function setPhase(p: PipelineState, phase: string): void {
  ensureRunning(p, 'set phase on');
  if (!VALID_PHASES.includes(phase)) {
    throw new Error(`unknown phase: ${phase}`);
  }
  p.phase = phase;
  p.updated_at = now();
  persist(p);
}

/** Record a simplify/review verdict ("pass" or "fix") and persist. */
export function setVerdict(p: PipelineState, verdict: string): void {
  ensureRunning(p, 'set verdict on');
  if (!VALID_VERDICTS.includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  p.verdict = verdict;
  p.updated_at = now();
  persist(p);
}

/**
 * Terminate the pipeline: status "done" when ok, else "failed".
 * Idempotent on an already-finished pipeline (no-op).
 */
export function finishPipeline(p: PipelineState, ok: boolean, error: string | null = null): void {
  if (p.status === 'done' || p.status === 'failed') {
    return;
  }
  p.status = ok ? 'done' : 'failed';
  if (ok) {
    p.error = null;
  } else if (error !== null) {
    p.error = error;
  }
  p.updated_at = now();
  persist(p);
}

/** Single-line pipeline status, e.g. for before_agent_start injection. */
export function statusText(p: PipelineState): string {
  const base = `[Jovaltus pipeline] tool=${p.tool} phase=${p.phase} status=${p.status} run_dir=${p.run_dir}`;
  if (p.tool === 'plan' && p.phase === 'done' && p.status === 'done') {
    return `${base} — plan complete: ${p.run_dir}/tasks.md`;
  }
  return base;
}

/** Remove the "pipeline" key (back to idle), keeping other keys. */
export function resetPipeline(): void {
  const state = loadRaw();
  const { [PIPELINE_KEY]: _removed, ...rest } = state;
  void _removed;
  try {
    writeFileSync(stateFilePath(), JSON.stringify(rest, null, 2), 'utf8');
  } catch {
    // Best-effort, same as persist().
  }
}
