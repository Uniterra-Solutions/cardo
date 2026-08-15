/**
 * Jovaltus deterministic pipeline state machine (pi-agent port) — SQLite
 * session store.
 *
 * Ported from the Hermes plugin's `src/jovaltus/state.py`. Every pipeline
 * run (plan / execute / simplify / review) is persisted as a **session row**
 * in a SQLite database at `<agentDir>/jovaltus.sqlite` (`agentDir` is pi's
 * config dir, resolved via `getAgentDir()`). The session history survives
 * restarts, so past runs can be listed and resumed.
 *
 * Statuses:
 *   running     — the active pipeline (at most one per process).
 *   done        — completed successfully.
 *   failed      — finished with an error (phase subagent failure, missing
 *                 verdict, ...).
 *   interrupted — stopped WITHOUT an error: the tool call was aborted, the
 *                 session ended, a newer pipeline superseded it, or the
 *                 owning process died (orphan sweep on next access).
 *
 * The state machine is deliberately dumb: it records transitions and
 * persists them. Deciding *which* transition to take lives in the tool
 * handlers and the `agent_settled` event (this module never imports pi
 * APIs beyond `getAgentDir`).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const PLUGIN_NAME = 'jovaltus';

export const PHASES: readonly string[] = [
  'prd',
  'design',
  'plan_waiting',
  'execute',
  'simplify',
  'simplify_waiting',
  'review',
  'review_waiting',
] as const;

export const STATUSES: readonly string[] = [
  'idle',
  'running',
  'done',
  'failed',
  'interrupted',
] as const;

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
  /** unique session id (resume_session accepts it or the run_dir) */
  id: string;
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
  /** ISO timestamp of the last transition */
  updated_at: string;
  error: string | null;
  /** OS pid of the process that owns this run (orphan detection) */
  pid: number;
  /** ISO timestamp */
  created_at: string;
  /** ISO timestamp when the run left "running", or null while active */
  ended_at: string | null;
}

interface SessionRow {
  id: string;
  run_dir: string;
  tool: string;
  phase: string;
  status: string;
  user_requirements: string;
  plan_path: string | null;
  loop_iteration: number;
  verdict: string | null;
  error: string | null;
  pid: number;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  run_dir TEXT NOT NULL,
  tool TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  user_requirements TEXT NOT NULL DEFAULT '',
  plan_path TEXT,
  loop_iteration INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  error TEXT,
  pid INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
)`;

function now(): string {
  return new Date().toISOString();
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

// DB access ----------------------------------------------------------------

let db: DatabaseSync | null = null;
let dbPath: string | null = null;

function dbFile(): string {
  return path.join(getAgentDir(), `${PLUGIN_NAME}.sqlite`);
}

/** Open (or recover) the sessions DB for the current agent dir. */
function openDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const attempt = (): DatabaseSync => {
    const d = new DatabaseSync(file);
    d.exec('PRAGMA journal_mode = WAL');
    d.exec(SCHEMA);
    migrateLegacyIfEmpty(d, file);
    return d;
  };
  try {
    return attempt();
  } catch {
    // Corrupt or unreadable DB file: drop it and recreate — the session
    // store must never block the pipeline.
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort
    }
    return attempt();
  }
}

/** Lazily open the DB for the current agent dir (re-opens if it changed). */
function getDb(): DatabaseSync {
  const file = dbFile();
  if (db !== null && dbPath === file) {
    return db;
  }
  try {
    db?.close();
  } catch {
    // best-effort
  }
  db = openDb(file);
  dbPath = file;
  return db;
}

// Legacy migration ----------------------------------------------------------

/**
 * One-time migration from the pre-SQLite single-pipeline JSON file
 * (`<agentDir>/jovaltus.json`, key "pipeline"). Runs only when the sessions
 * table is empty. A legacy "running" pipeline is recorded as "interrupted":
 * the process that owned it is gone by the time we migrate.
 */
function migrateLegacyIfEmpty(d: DatabaseSync, file: string): void {
  const count = d.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  if (count.n > 0) {
    return;
  }
  let raw: Record<string, unknown> = {};
  try {
    const text = readFileSync(path.join(path.dirname(file), `${PLUGIN_NAME}.json`), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    return; // no legacy file (or unparsable) — nothing to migrate
  }
  const legacy = raw['pipeline'];
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return;
  }
  const data = legacy as Record<string, unknown>;
  if (typeof data['run_dir'] !== 'string' || typeof data['tool'] !== 'string') {
    return;
  }
  const p: PipelineState = {
    id: randomUUID(),
    run_dir: stringField(data, 'run_dir'),
    tool: stringField(data, 'tool'),
    phase: stringField(data, 'phase'),
    status: stringField(data, 'status'),
    user_requirements: stringField(data, 'user_requirements'),
    plan_path: optionalString(data['plan_path']),
    loop_iteration: Number(data['loop_iteration'] ?? 0),
    verdict: optionalString(data['verdict']),
    updated_at: stringField(data, 'updated_at') || now(),
    error: optionalString(data['error']),
    pid: 0,
    created_at: stringField(data, 'updated_at') || now(),
    ended_at: null,
  };
  if (!VALID_PHASES.includes(p.phase) || !Object.keys(FIRST_PHASE).includes(p.tool)) {
    return; // corrupt legacy pipeline: skip it, do not block a fresh start
  }
  if (p.status === 'running') {
    p.status = 'interrupted';
    p.ended_at = now();
  } else if (p.status === 'done' || p.status === 'failed') {
    p.ended_at = p.updated_at;
  } else {
    p.status = 'interrupted';
    p.ended_at = now();
  }
  insertRow(d, p);
}

// Row mapping ---------------------------------------------------------------

function rowToPipeline(row: SessionRow): PipelineState {
  return {
    id: row.id,
    run_dir: row.run_dir,
    tool: row.tool,
    phase: row.phase,
    status: row.status,
    user_requirements: row.user_requirements,
    plan_path: row.plan_path,
    loop_iteration: row.loop_iteration,
    verdict: row.verdict,
    error: row.error,
    pid: row.pid,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at,
  };
}

function insertRow(d: DatabaseSync, p: PipelineState): void {
  d.prepare(
    `INSERT INTO sessions (
       id, run_dir, tool, phase, status, user_requirements, plan_path,
       loop_iteration, verdict, error, pid, created_at, updated_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.run_dir,
    p.tool,
    p.phase,
    p.status,
    p.user_requirements,
    p.plan_path,
    p.loop_iteration,
    p.verdict,
    p.error,
    p.pid,
    p.created_at,
    p.updated_at,
    p.ended_at,
  );
}

/**
 * A row that is still "running" but belongs to a dead process was left
 * behind by a crash, kill, or restart — that is an interruption, not an
 * error. Mark it so before the active-pipeline lookups run.
 */
function sweepOrphans(d: DatabaseSync): void {
  d.prepare(
    "UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status = 'running' AND pid != ?",
  ).run(now(), process.pid);
}

/** Persist a live-pipeline mutation; best-effort (never throws). */
function persistLive(p: PipelineState): void {
  try {
    const d = getDb();
    d.prepare(
      `UPDATE sessions SET phase = ?, status = ?, user_requirements = ?,
         plan_path = ?, loop_iteration = ?, verdict = ?, error = ?,
         updated_at = ?, ended_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(
      p.phase,
      p.status,
      p.user_requirements,
      p.plan_path,
      p.loop_iteration,
      p.verdict,
      p.error,
      p.updated_at,
      p.ended_at,
      p.id,
    );
  } catch {
    // Best-effort persistence: a read-only agent dir must not crash the
    // pipeline — state still lives in the in-memory object for the run.
  }
}

/** A pipeline row is usable only when its phase and tool are in-domain. */
function isValidPipeline(p: PipelineState): boolean {
  return VALID_PHASES.includes(p.phase) && Object.keys(FIRST_PHASE).includes(p.tool);
}

// Public API ----------------------------------------------------------------

/**
 * Return the most recent pipeline session (any status), or null when there
 * are none. Mirrors the pre-history "the one pipeline" semantics: the latest
 * session is what the hooks and status injection act on. Running rows owned
 * by a dead process are swept to "interrupted" first, so a crashed pipeline
 * can never masquerade as active. A row whose phase/tool is unknown
 * (corrupted state) is dropped so it can never deadlock the chain.
 */
export function getPipeline(): PipelineState | null {
  try {
    const d = getDb();
    sweepOrphans(d);
    const row = d.prepare('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1').get() as
      SessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    const p = rowToPipeline(row);
    if (!isValidPipeline(p)) {
      d.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

/**
 * Start (or supersede) a pipeline run for `tool`. The new pipeline begins in
 * the tool's first phase with status "running"; any other running session is
 * interrupted (only one active pipeline exists at a time).
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
  const timestamp = now();
  const p: PipelineState = {
    id: randomUUID(),
    run_dir: runDir,
    tool,
    phase: firstPhase,
    status: 'running',
    user_requirements: userRequirements,
    plan_path: planPath,
    loop_iteration: 0,
    verdict: null,
    error: null,
    pid: process.pid,
    created_at: timestamp,
    updated_at: timestamp,
    ended_at: null,
  };
  try {
    const d = getDb();
    sweepOrphans(d);
    d.prepare(
      "UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status = 'running' AND id != ?",
    ).run(timestamp, p.id);
    insertRow(d, p);
  } catch {
    // Best-effort persistence, same as persistLive.
  }
  return p;
}

function ensureRunning(p: PipelineState, what = 'mutate'): void {
  if (p.status === 'done' || p.status === 'failed' || p.status === 'interrupted') {
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
  persistLive(p);
}

/** Record a simplify/review verdict ("pass" or "fix") and persist. */
export function setVerdict(p: PipelineState, verdict: string): void {
  ensureRunning(p, 'set verdict on');
  if (!VALID_VERDICTS.includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  p.verdict = verdict;
  p.updated_at = now();
  persistLive(p);
}

/**
 * Terminate the pipeline: status "done" when ok, else "failed".
 * Idempotent on an already-finished pipeline (no-op).
 */
export function finishPipeline(p: PipelineState, ok: boolean, error: string | null = null): void {
  if (p.status === 'done' || p.status === 'failed' || p.status === 'interrupted') {
    return;
  }
  p.status = ok ? 'done' : 'failed';
  if (ok) {
    p.error = null;
  } else if (error !== null) {
    p.error = error;
  }
  p.updated_at = now();
  p.ended_at = p.updated_at;
  persistLive(p);
}

/**
 * Mark a running pipeline as interrupted (stopped without an error: aborted
 * tool call, ended session, superseded, or orphaned process). No-op on a
 * finished pipeline.
 */
export function markInterrupted(p: PipelineState): void {
  if (p.status === 'done' || p.status === 'failed' || p.status === 'interrupted') {
    return;
  }
  p.status = 'interrupted';
  p.updated_at = now();
  p.ended_at = p.updated_at;
  persistLive(p);
}

/** Every session row, newest first. */
export function listSessions(): PipelineState[] {
  try {
    const d = getDb();
    sweepOrphans(d);
    const rows = d
      .prepare('SELECT * FROM sessions ORDER BY rowid DESC')
      .all() as unknown as SessionRow[];
    return rows.map(rowToPipeline).filter(isValidPipeline);
  } catch {
    return [];
  }
}

/** Find a session by id, or by run_dir (newest match). Null when absent. */
export function getSession(idOrRunDir: string): PipelineState | null {
  const key = idOrRunDir.trim();
  if (!key) {
    return null;
  }
  try {
    const d = getDb();
    const byId = d.prepare('SELECT * FROM sessions WHERE id = ?').get(key) as
      SessionRow | undefined;
    if (byId !== undefined) {
      const p = rowToPipeline(byId);
      return isValidPipeline(p) ? p : null;
    }
    const byRunDir = d
      .prepare('SELECT * FROM sessions WHERE run_dir = ? ORDER BY rowid DESC LIMIT 1')
      .get(key) as SessionRow | undefined;
    if (byRunDir === undefined) {
      return null;
    }
    const p = rowToPipeline(byRunDir);
    return isValidPipeline(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Re-activate a finished (interrupted or failed) session so the pipeline can
 * continue from where it stopped. Throws when the session is missing, still
 * running, or already completed successfully.
 */
export function resumeSession(idOrRunDir: string): PipelineState {
  // An orphaned "running" row (the owning process crashed) is resumable, not
  // "already running" — sweep before the lookup so a direct resume works even
  // when no hook touched the store since the crash.
  try {
    sweepOrphans(getDb());
  } catch {
    // best-effort, same as the other store accessors
  }
  const existing = getSession(idOrRunDir);
  if (existing === null) {
    throw new Error(`no Jovaltus session found: ${idOrRunDir}`);
  }
  if (existing.status === 'running') {
    throw new Error(`session ${existing.id} is already running — nothing to resume`);
  }
  if (existing.status === 'done') {
    throw new Error(`session ${existing.id} already completed successfully — nothing to resume`);
  }
  const p: PipelineState = {
    ...existing,
    status: 'running',
    error: null,
    pid: process.pid,
    ended_at: null,
    updated_at: now(),
  };
  try {
    const d = getDb();
    // The resumed session becomes the active one; any other running session
    // is superseded (interrupted).
    d.prepare(
      "UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status = 'running' AND id != ?",
    ).run(p.updated_at, p.id);
    d.prepare(
      "UPDATE sessions SET status = 'running', error = ?, pid = ?, ended_at = ?, updated_at = ? WHERE id = ?",
    ).run(null, process.pid, p.ended_at, p.updated_at, p.id);
  } catch {
    // Best-effort persistence, same as persistLive.
  }
  return p;
}

/** Single-line pipeline status, e.g. for before_agent_start injection. */
export function statusText(p: PipelineState): string {
  const base = `[Jovaltus pipeline] id=${p.id} tool=${p.tool} phase=${p.phase} status=${p.status} run_dir=${p.run_dir}`;
  if (p.tool === 'plan' && p.phase === 'plan_waiting' && p.status === 'running') {
    return `${base} — waiting for the main agent to write ${p.run_dir}/execution-plan.json`;
  }
  if (p.tool === 'plan' && p.phase === 'done' && p.status === 'done') {
    return `${base} — plan complete: ${p.run_dir}/execution-plan.json`;
  }
  return base;
}
