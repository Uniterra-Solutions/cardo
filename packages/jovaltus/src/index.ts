/**
 * Jovaltus pi-agent extension — subagent-driven development pipeline.
 *
 * Port of the Hermes plugin (`Uniterra-Solutions/jovaltus`) to a pi
 * extension. Registers six tools (`plan` / `execute` / `simplify` /
 * `review` / `list_sessions` / `resume_session`) and drives the same
 * deterministic phase chains, replacing Hermes's `subagent_lifecycle` with
 * child `pi` processes (see `dispatch.ts`) and Hermes's hooks with pi
 * events:
 *
 * - `before_agent_start` → `pre_llm_call` equivalent: injects pipeline
 *   status into every main-agent turn.
 * - `agent_settled` → `post_llm_call` equivalent: after the main agent
 *   finishes a fixing turn, re-dispatches the reviewer for a parked
 *   `*_waiting` pipeline (verdict-driven loop, no cap).
 * - `session_shutdown` → a still-running pipeline becomes `interrupted`
 *   (stopped without an error).
 *
 * Every pipeline run is persisted as a session row in a SQLite store
 * (`<agentDir>/jovaltus.sqlite`, see `state.ts`), so past sessions can be
 * listed (`list_sessions`) and resumed (`resume_session`).
 *
 * NOTE: this file is the pi extension ENTRY POINT — pi's loader requires a
 * default-exported factory function (`jiti.import(path, { default: true })`
 * then `typeof factory === "function"`). This is the ONE default export in
 * this package; every other module uses named exports only (AGENTS.md).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Type } from 'typebox';
import { CHAIN, WAITING_PHASES, readFindings, readVerdict, waitingPhase } from './chain.js';
import { runPhase } from './dispatch.js';
import { buildContext, renderPrompt } from './prompts.js';
import * as jstate from './state.js';
import type { PipelineState } from './state.js';

// Run dir helpers -----------------------------------------------------------

function makeSlug(requirements: string): string {
  const words = requirements.match(/\w+/g)?.slice(0, 6) ?? [];
  if (words.length === 0) {
    return 'plan';
  }
  return words.join('-').toLowerCase();
}

/** `<cwd>/.plan/<YYYYmmdd>/<plan_name>/` (suffixed -2/-3… on collision). */
function computeRunDir(cwd: string, requirements: string): string {
  const base = path.join(cwd, '.plan');
  const timestamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const planName = makeSlug(requirements);
  let runDir = path.join(base, timestamp, planName);
  let suffix = 2;
  while (dirExists(runDir)) {
    runDir = path.join(base, timestamp, `${planName}-${String(suffix)}`);
    suffix += 1;
  }
  return runDir;
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function optionalPlan(params: { plan?: string }): string | null {
  const plan = (params.plan ?? '').trim();
  return plan ? plan : null;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve `(run_dir, plan_path)` for a simplify/review run. */
function resolveReviewTarget(
  cwd: string,
  planPath: string | null,
  tool: string,
): { runDir: string; planPath: string | null } {
  if (planPath !== null) {
    const resolved = path.resolve(planPath);
    return { runDir: path.dirname(resolved), planPath: resolved };
  }
  const runDir = computeRunDir(cwd, tool);
  mkdirSync(runDir, { recursive: true });
  return { runDir, planPath: null };
}

// Dispatch ----------------------------------------------------------------

interface PhaseDispatchContext {
  cwd: string;
  model: string | null;
  thinkingLevel: string | null;
  signal?: AbortSignal;
  onUpdate?: (text: string) => void;
  /** Optional resume instructions appended to the phase prompt. */
  resumeNote?: string;
}

/** Run one pipeline phase in a child pi process and return its result. */
async function dispatchPhase(
  p: PipelineState,
  phase: string,
  ctx: PhaseDispatchContext,
): Promise<{ ok: boolean; message: string; output: string }> {
  const prompt = renderPrompt(p, phase, ctx.cwd);
  const context = buildContext(p, ctx.cwd);
  const task = `${context}\n\nTask: execute the phase described above.`;
  try {
    const result = await runPhase({
      cwd: ctx.cwd,
      prompt: ctx.resumeNote ? `${prompt}\n\n${ctx.resumeNote}` : prompt,
      task,
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      signal: ctx.signal,
      onText: ctx.onUpdate,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `phase ${phase} failed (exit ${String(result.exitCode)}): ${result.error || result.output || 'no output'}`,
        output: result.output,
      };
    }
    return { ok: true, message: '', output: result.output };
  } catch (err) {
    return { ok: false, message: `phase ${phase} dispatch error: ${String(err)}`, output: '' };
  }
}

function modelPattern(ctx: ExtensionContext): string | null {
  const model = ctx.model;
  if (!model) {
    return null;
  }
  const base = `${model.provider}/${model.id}`;
  const thinking = ctx.thinkingLevel;
  if (thinking && thinking !== 'off') {
    return `${base}:${thinking}`;
  }
  return base;
}

function dispatchCtx(ctx: ExtensionContext): PhaseDispatchContext {
  return {
    cwd: ctx.cwd,
    model: modelPattern(ctx),
    thinkingLevel: ctx.thinkingLevel ?? null,
    signal: ctx.signal,
  };
}

// Tool result helpers --------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details };
}

function errorResult(message: string): ToolResult {
  return textResult(message, { isError: true });
}

function startedResult(p: PipelineState, phase: string, output: string): ToolResult {
  return textResult(
    `${p.tool} pipeline complete: phase ${phase} finished in ${p.run_dir}\n\n${output.trim()}`,
    { run_dir: p.run_dir },
  );
}

// Phase chains ---------------------------------------------------------------

const PLAN_PHASES: readonly string[] = ['prd', 'research', 'acceptance', 'tasks'];

/** The plan phases that still need to run for a pipeline at `p.phase`. */
function remainingPlanPhases(p: PipelineState): readonly string[] {
  const startIndex = PLAN_PHASES.indexOf(p.phase);
  return startIndex === -1 ? PLAN_PHASES : PLAN_PHASES.slice(startIndex);
}

/**
 * Fail a dispatched phase. An aborted tool call (user interrupt) is NOT an
 * error: the pipeline is marked `interrupted` so it can be resumed later.
 * Anything else is a real failure (`failed`).
 */
function failPipeline(p: PipelineState, ctx: PhaseDispatchContext, message: string): ToolResult {
  if (ctx.signal?.aborted) {
    jstate.markInterrupted(p);
    return errorResult(`interrupted during ${p.tool}: ${message}`);
  }
  jstate.finishPipeline(p, false, message);
  return errorResult(message);
}

/** Run the plan chain from the pipeline's current phase to completion. */
async function runPlanChain(p: PipelineState, ctx: PhaseDispatchContext): Promise<ToolResult> {
  for (const phase of remainingPlanPhases(p)) {
    const result = await dispatchPhase(p, phase, ctx);
    if (!result.ok) {
      return failPipeline(p, ctx, result.message);
    }
    const next = CHAIN['plan']?.[phase];
    if (next === undefined) {
      return failPipeline(p, ctx, `no next phase for plan/${phase}`);
    }
    jstate.setPhase(p, next);
  }
  jstate.finishPipeline(p, true);
  return startedResult(p, 'tasks', '');
}

/** Run the execute phase to completion. */
async function runExecutePhase(p: PipelineState, ctx: PhaseDispatchContext): Promise<ToolResult> {
  const result = await dispatchPhase(p, 'execute', ctx);
  if (!result.ok) {
    return failPipeline(p, ctx, result.message);
  }
  jstate.setPhase(p, 'done');
  jstate.finishPipeline(p, true);
  return startedResult(p, 'execute', result.output);
}

/**
 * Run one reviewer round: dispatch the reviewer child, read verdict.json,
 * then either finish (pass) or park in the waiting phase (fix) so the main
 * agent fixes and `agent_settled` re-dispatches.
 */
async function runReviewRound(
  p: PipelineState,
  tool: 'simplify' | 'review',
  ctx: PhaseDispatchContext,
): Promise<ToolResult> {
  const phase = tool;
  const result = await dispatchPhase(p, phase, ctx);
  if (!result.ok) {
    return failPipeline(p, ctx, result.message);
  }
  const verdict = readVerdict(p);
  if (verdict === null) {
    const message = `verdict.json missing or invalid in ${p.run_dir}`;
    jstate.finishPipeline(p, false, message);
    return errorResult(message);
  }
  if (verdict === 'pass') {
    jstate.setVerdict(p, 'pass');
    jstate.setPhase(p, 'done');
    jstate.finishPipeline(p, true);
    return startedResult(p, phase, result.output);
  }
  // "fix": the main agent performs the fixes. Park the pipeline in the
  // waiting phase and surface the findings to the main agent; the
  // agent_settled event re-dispatches the reviewer after this fixing turn.
  p.loop_iteration += 1;
  jstate.setVerdict(p, 'fix');
  jstate.setPhase(p, waitingPhase(tool));
  const findings = readFindings(p);
  return textResult(
    `[Jovaltus] ${tool} round ${String(p.loop_iteration)}: reviewer found defects. ` +
      `Fix them in the working tree; the reviewer re-runs automatically after this turn.\n\n${findings}`.trim(),
    { run_dir: p.run_dir, verdict: 'fix', findings },
  );
}

// Tool handlers ---------------------------------------------------------------

async function planHandler(
  params: { user_requirements: string },
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const requirements = params.user_requirements.trim();
  if (!requirements) {
    return errorResult('plan requires user_requirements');
  }
  let runDir: string;
  try {
    runDir = computeRunDir(ctx.cwd, requirements);
    mkdirSync(runDir, { recursive: true });
  } catch (err) {
    return errorResult(`cannot create run directory: ${String(err)}`);
  }
  const p = jstate.startPipeline('plan', runDir, requirements, null);
  return await runPlanChain(p, dispatchCtx(ctx));
}

async function executeHandler(
  params: { plan: string },
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const planPath = optionalPlan(params);
  if (planPath === null) {
    return errorResult('execute requires a plan path');
  }
  if (!fileExists(planPath)) {
    return errorResult(`plan path does not exist: ${planPath}`);
  }
  const resolved = path.resolve(planPath);
  const runDir = path.dirname(resolved);
  const p = jstate.startPipeline('execute', runDir, '', resolved);
  return await runExecutePhase(p, dispatchCtx(ctx));
}

async function reviewToolHandler(
  tool: 'simplify' | 'review',
  params: { plan?: string },
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const planPath = optionalPlan(params);
  if (planPath !== null && !fileExists(planPath)) {
    return errorResult(`plan path does not exist: ${planPath}`);
  }
  let target: { runDir: string; planPath: string | null };
  try {
    target = resolveReviewTarget(ctx.cwd, planPath, tool);
  } catch (err) {
    return errorResult(String(err));
  }
  const p = jstate.startPipeline(tool, target.runDir, '', target.planPath);
  return await runReviewRound(p, tool, dispatchCtx(ctx));
}

/**
 * The phase a resumed session should re-enter. A session parked in a fix
 * round (`*_waiting`) falls back to the reviewer phase so the current diff
 * is re-checked before the main agent fixes again; any other session
 * resumes at the exact phase it was interrupted in.
 */
function resumeTargetPhase(p: PipelineState): string {
  if (p.phase === 'simplify_waiting') {
    return 'simplify';
  }
  if (p.phase === 'review_waiting') {
    return 'review';
  }
  return p.phase;
}

/**
 * Resume instructions appended to the resumed phase's prompt: the child has
 * no conversation context, so the artifacts already on disk ARE its context.
 * It must continue the in-progress work rather than restart from scratch.
 */
function buildResumeNote(p: PipelineState): string {
  return (
    '## Resumed run (not a fresh start)\n' +
    `This pipeline session (id ${p.id}, started ${p.created_at}) was not completed; ` +
    `its artifacts are still on disk in ${p.run_dir}. Continue the work that was in ` +
    'progress instead of restarting from scratch:\n' +
    '- Inspect the artifacts already written in the run directory and the working tree ' +
    '(git status / git diff) before acting.\n' +
    '- Reuse completed artifacts (prd.md, research.md, acceptance.md, tasks.md, ...) as-is when valid.\n' +
    '- For the execute phase, infer which tasks are already done from the working tree ' +
    'and implement only what remains.\n' +
    '- If this is a reviewer round, re-run your verdict against the current diff.'
  );
}

async function resumeHandler(
  params: { session_id: string },
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const sessionId = params.session_id.trim();
  if (!sessionId) {
    return errorResult('resume_session requires a session_id');
  }
  let p: PipelineState;
  try {
    p = jstate.resumeSession(sessionId);
  } catch (err) {
    return errorResult(String(err));
  }
  const target = resumeTargetPhase(p);
  const dctx: PhaseDispatchContext = { ...dispatchCtx(ctx), resumeNote: buildResumeNote(p) };
  if (target !== p.phase) {
    try {
      jstate.setPhase(p, target);
    } catch (err) {
      return errorResult(String(err));
    }
  }
  let result: ToolResult;
  if (p.tool === 'plan') {
    result = await runPlanChain(p, dctx);
  } else if (p.tool === 'execute') {
    result = await runExecutePhase(p, dctx);
  } else if (p.tool === 'simplify' || p.tool === 'review') {
    result = await runReviewRound(p, p.tool, dctx);
  } else {
    return errorResult(`cannot resume session ${p.id}: unknown tool ${p.tool}`);
  }
  if (result.details['isError'] === true) {
    return result;
  }
  const text =
    `[Jovaltus] resumed session ${p.id} (${p.tool}, phase ${target})\n\n${result.content[0]?.text ?? ''}`.trim();
  return textResult(text, result.details);
}

// Session listing -------------------------------------------------------------

function sessionSummary(p: PipelineState): Record<string, unknown> {
  return {
    id: p.id,
    tool: p.tool,
    phase: p.phase,
    status: p.status,
    user_requirements: p.user_requirements,
    run_dir: p.run_dir,
    plan_path: p.plan_path,
    loop_iteration: p.loop_iteration,
    verdict: p.verdict,
    created_at: p.created_at,
    updated_at: p.updated_at,
    ended_at: p.ended_at,
  };
}

function formatSessionList(sessions: PipelineState[]): string {
  if (sessions.length === 0) {
    return 'No Jovaltus pipeline sessions yet.';
  }
  const header = ['id', 'tool', 'status', 'phase', 'updated_at', 'run_dir', 'requirements'];
  const rows = sessions.map((s) => {
    const req =
      s.user_requirements.length > 48
        ? `${s.user_requirements.slice(0, 45)}...`
        : s.user_requirements;
    return [s.id, s.tool, s.status, s.phase, s.updated_at, s.run_dir, req];
  });
  return ['| ' + header.join(' | ') + ' |', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join(
    '\n',
  );
}

// Extension factory -----------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'plan',
    label: 'Plan',
    description:
      'Draw up a thorough software-engineering implementation plan. ' +
      'Runs the Jovaltus planning pipeline in sequence (PRD → research → ' +
      'acceptance → task DAG), each phase as an isolated subagent, and ' +
      'writes the artifacts into <cwd>/.plan/<date>/<name>/. Requires user_requirements.',
    promptSnippet: 'Plan a feature or refactor via the Jovaltus pipeline',
    promptGuidelines: [
      'Use plan when the user hands over a complex software-engineering request that needs planning (cross-module refactor, new feature, greenfield project).',
    ],
    parameters: Type.Object({
      user_requirements: Type.String({ description: 'The user requirements to plan' }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      return await planHandler(params, ctx);
    },
  });

  pi.registerTool({
    name: 'execute',
    label: 'Execute',
    description:
      'Implement a user-approved plan. Runs the Jovaltus execute phase as ' +
      "an isolated subagent that drives the plan's task DAG level by level, " +
      'leaving the changes uncommitted in the working tree for simplify/review. ' +
      'Requires a plan path.',
    promptSnippet: 'Execute a user-approved plan via the Jovaltus pipeline',
    promptGuidelines: ['Use execute only after the user has explicitly approved a specific plan.'],
    parameters: Type.Object({
      plan: Type.String({ description: 'Path to the plan manifest (tasks.md)' }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      return await executeHandler(params, ctx);
    },
  });

  pi.registerTool({
    name: 'simplify',
    label: 'Simplify',
    description:
      'Find simplification opportunities in the uncommitted diff. Runs the ' +
      'Jovaltus simplify review as an isolated subagent; on a fix verdict you ' +
      '(the main agent) apply the suggestions and the reviewer re-runs ' +
      'automatically until it passes. Takes an optional plan path — without ' +
      'one it simplifies the uncommitted changes directly.',
    promptSnippet: 'Simplify uncommitted code changes via the Jovaltus pipeline',
    promptGuidelines: [
      'Use simplify when the user asks to simplify specific code changes, or a completed plan has not yet been simplified.',
    ],
    parameters: Type.Object({
      plan: Type.Optional(Type.String({ description: 'Optional plan path' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      return await reviewToolHandler('simplify', params, ctx);
    },
  });

  pi.registerTool({
    name: 'review',
    label: 'Review',
    description:
      'Adversarially review the uncommitted diff for bugs, security holes, ' +
      'and contract violations. Runs the Jovaltus review as an isolated ' +
      'subagent; on a fix verdict you (the main agent) fix the findings and ' +
      'the reviewer re-runs automatically until it passes. Takes an optional ' +
      'plan path — without one it reviews the uncommitted changes directly.',
    promptSnippet: 'Review uncommitted code changes via the Jovaltus pipeline',
    promptGuidelines: [
      'Use review when the user asks to review specific code changes, or a completed plan has not yet been reviewed.',
    ],
    parameters: Type.Object({
      plan: Type.Optional(Type.String({ description: 'Optional plan path' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      return await reviewToolHandler('review', params, ctx);
    },
  });

  pi.registerTool({
    name: 'list_sessions',
    label: 'List Sessions',
    description:
      'List every past Jovaltus pipeline session and its status (running, ' +
      'done, failed, interrupted). Sessions are persisted in a SQLite store ' +
      'in the pi agent dir, so they survive restarts. Optionally filter by ' +
      'status. Use this before resume_session to find the id (or run dir) ' +
      'of a session to resume.',
    promptSnippet: 'List Jovaltus pipeline sessions and their status',
    promptGuidelines: [
      'Use list_sessions when the user asks what Jovaltus runs happened before, or to find a session id to resume.',
    ],
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: 'Optional filter: running | done | failed | interrupted',
        }),
      ),
    }),
    execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      void ctx;
      const filter = typeof params.status === 'string' ? params.status.trim() : '';
      const sessions = jstate.listSessions().filter((s) => (filter ? s.status === filter : true));
      if (filter && sessions.length === 0) {
        return Promise.resolve(errorResult(`no sessions with status ${filter}`));
      }
      return Promise.resolve(
        textResult(formatSessionList(sessions), {
          sessions: sessions.map(sessionSummary),
        }),
      );
    },
  });

  pi.registerTool({
    name: 'resume_session',
    label: 'Resume Session',
    description:
      'Resume an interrupted or failed Jovaltus pipeline session from where ' +
      'it stopped. Accepts the session id or its run directory. A session ' +
      'parked in a fix round resumes by re-running the reviewer against the ' +
      'current diff; a session interrupted inside a phase re-runs that ' +
      'phase, reusing the artifacts already on disk as context so work is ' +
      'continued, not restarted.',
    promptSnippet: 'Resume an interrupted Jovaltus pipeline session',
    promptGuidelines: [
      'Use resume_session when a previous plan/execute/simplify/review run was interrupted or failed and the user wants to continue it.',
    ],
    parameters: Type.Object({
      session_id: Type.String({
        description: 'Session id or run directory of the session to resume',
      }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      return await resumeHandler(params, ctx);
    },
  });

  // State injection (pre_llm_call equivalent).
  pi.on('before_agent_start', (event, ctx) => {
    void ctx;
    const p = jstate.getPipeline();
    if (p === null) {
      return;
    }
    return {
      systemPrompt: event.systemPrompt + `\n\n${jstate.statusText(p)}`,
    };
  });

  // Reviewer re-dispatch after the main agent's fixing turn (post_llm_call
  // equivalent). Acts only on a parked `*_waiting` pipeline; everything else
  // is a no-op so the hook is effectively absent before/after a run.
  pi.on('agent_settled', async (_event, ctx) => {
    const p = jstate.getPipeline();
    if (p === null || p.status !== 'running') {
      return;
    }
    if (!WAITING_PHASES.includes(p.phase)) {
      return;
    }
    const tool = p.tool;
    if (tool !== 'simplify' && tool !== 'review') {
      return;
    }
    const next = CHAIN[tool]?.[p.phase];
    if (next === undefined || next === 'done') {
      jstate.setPhase(p, 'done');
      jstate.finishPipeline(p, true);
      ctx.ui.notify('Jovaltus review passed', 'info');
      return;
    }
    jstate.setPhase(p, next);
    const result = await runReviewRound(p, tool, dispatchCtx(ctx));
    if (result.details['verdict'] === 'fix') {
      // Wake the main agent with the new findings (fix-request equivalent).
      const findings = readFindings(p);
      pi.sendUserMessage(
        `[Jovaltus] ${tool} round ${String(p.loop_iteration)}: reviewer found defects again. ` +
          `Fix them in the working tree; the reviewer re-runs automatically after this turn.\n\n${findings}`.trim(),
      );
    } else {
      ctx.ui.notify(`Jovaltus ${tool} complete`, 'info');
    }
  });

  // A running pipeline that outlives the session was stopped without an
  // error — record it as interrupted so it can be listed and resumed later.
  pi.on('session_shutdown', (_event, ctx) => {
    void ctx;
    const p = jstate.getPipeline();
    if (p !== null && p.status === 'running') {
      jstate.markInterrupted(p);
    }
  });
}
