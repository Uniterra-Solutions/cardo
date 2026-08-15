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
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Type } from 'typebox';
import { CHAIN, WAITING_PHASES, readFindings, readVerdict, waitingPhase } from './chain.js';
import { runPhase } from './dispatch.js';
import {
  buildExecuteWidgetLines,
  JOVALTUS_EXECUTE_STATUS_KEY,
  JOVALTUS_EXECUTE_WIDGET_KEY,
  planExecuteWidgetAgentDone,
  planExecuteWidgetAgentStart,
  planExecuteWidgetDone,
  planExecuteWidgetInitial,
  registerPlanMode,
} from './plan-mode.js';
import { CLARIFY_FILENAME, EXECUTION_PLAN_FILENAME, readExecutionPlan } from './plan-json.js';
import { planToMermaid } from './plan-mermaid.js';
import { createProgress, markDone, startRunning } from './plan-progress.js';
import { deriveExecutionSteps } from './plan-steps.js';
import type { ExecutionPlan, PlanAgent } from './plan.js';
import { buildContext, renderAgentPrompt, renderPrompt } from './prompts.js';
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
  /** Extension UI surface, present in interactive hosts; used to stream the execute panel. */
  ui?: ExtensionContext['ui'];
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
    ui: ctx.ui,
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

/**
 * Human-in-loop requirement clarification, once per run (right after the
 * PRD). Asks the user via a synchronous dialog; their answer is stored as
 * `clarify.md` and becomes part of the context injected into later phases.
 * Skipped when headless, when the dialog is unavailable, or when already
 * answered (a resumed run).
 */
async function clarifyRequirements(p: PipelineState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui.input !== 'function') {
    return;
  }
  const clarifyFile = path.join(p.run_dir, CLARIFY_FILENAME);
  if (fileExists(clarifyFile)) {
    return;
  }
  try {
    const answer = await ctx.ui.input(
      'Jovaltus 需求釐清',
      `PRD 已完成：${p.run_dir}/prd.md。如有補充或調整請輸入；直接按 Enter 表示需求已清晰。`,
    );
    if (answer !== undefined && answer.trim()) {
      writeFileSync(clarifyFile, answer.trim(), 'utf8');
    }
  } catch {
    // Dialog dismissed or unavailable — treat as "requirements are clear".
  }
}

/** The execution plan schema example shown in the handoff instructions. */
const EXECUTION_PLAN_EXAMPLE = {
  execution_mode: 'batched',
  batches: [
    [
      { id: 'db-schema', task_prompt: '设计 DB schema，完成後更新 PBT' },
      { id: 'stripe-client', task_prompt: '封装 Stripe client' },
    ],
    [{ id: 'webhook-handler', task_prompt: '实现 webhook 处理' }],
  ],
};

/**
 * Hand off to the main agent: write the FAILING property-based tests (the
 * red phase) and the execution plan JSON. Completion is artifact-driven —
 * the `agent_settled` hook finishes the pipeline once execution-plan.json
 * parses.
 */
function planHandoffResult(p: PipelineState): ToolResult {
  return textResult(
    `[Jovaltus] Plan pipeline ready for the main agent (phase: plan_waiting).\n\n` +
      `Artifacts already written:\n` +
      `- PRD: ${p.run_dir}/prd.md\n` +
      `- Design doc: ${p.run_dir}/design.md\n\n` +
      `Do the following two things now:\n` +
      `1. Write the FAILING property-based tests that encode the business logic ` +
      `as invariants (red phase — they must fail against the current code). ` +
      `Test location follows project conventions (e.g. <repo>/test/pbt/).\n` +
      `2. Write the execution plan JSON to ${p.run_dir}/${EXECUTION_PLAN_FILENAME}:\n\n` +
      `${JSON.stringify(EXECUTION_PLAN_EXAMPLE, null, 2)}\n\n` +
      `Schema rules:\n` +
      `- execution_mode: "serial" = N batches × 1 agent (a linear chain); ` +
      `"batched" = batches run serially, agents within a batch in parallel; ` +
      `"parallel" = one batch holding every agent.\n` +
      `- ids must match /^[A-Za-z0-9_-]+$/ and be globally unique; task_prompt non-empty.\n` +
      `- The PRD + design doc are auto-injected into every dispatched agent's ` +
      `context, so each task_prompt must be a self-contained instruction.\n` +
      `The pipeline finishes automatically once execution-plan.json is valid.`,
    { run_dir: p.run_dir },
  );
}

/**
 * Run the plan pipeline (plan mode): PRD subagent → requirement
 * clarification (human-in-loop) → design subagent → park in `plan_waiting`
 * with the PBT + execution-JSON handoff. Resume-aware: a phase that is
 * already past (or the parked phase itself) is not re-run.
 */
async function runPlanPipeline(
  p: PipelineState,
  ctx: ExtensionContext,
  dctx: PhaseDispatchContext,
): Promise<ToolResult> {
  if (p.phase === 'prd') {
    const result = await dispatchPhase(p, 'prd', dctx);
    if (!result.ok) {
      return failPipeline(p, dctx, result.message);
    }
    jstate.setPhase(p, 'design');
  }
  if (p.phase === 'design') {
    await clarifyRequirements(p, ctx);
    const result = await dispatchPhase(p, 'design', dctx);
    if (!result.ok) {
      return failPipeline(p, dctx, result.message);
    }
    jstate.setPhase(p, 'plan_waiting');
  }
  return planHandoffResult(p);
}

/**
 * Dispatch ONE execute-plan subagent: the child gets the role prompt
 * (execute-agent.md) with the PRD + design doc auto-injected, and the
 * agent's task_prompt as the task.
 */
async function dispatchAgent(
  p: PipelineState,
  agent: PlanAgent,
  ctx: PhaseDispatchContext,
): Promise<{ ok: boolean; message: string; output: string }> {
  const prompt = renderAgentPrompt(p, agent.id, agent.task_prompt, ctx.cwd);
  const context = buildContext(p, ctx.cwd);
  const task = `${context}\n\nTask: ${agent.task_prompt}`;
  try {
    const result = await runPhase({
      cwd: ctx.cwd,
      prompt,
      task,
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      signal: ctx.signal,
      onText: ctx.onUpdate,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: `agent ${agent.id} failed (exit ${String(result.exitCode)}): ${result.error || result.output || 'no output'}`,
        output: result.output,
      };
    }
    return { ok: true, message: '', output: result.output };
  } catch (err) {
    return { ok: false, message: `agent ${agent.id} dispatch error: ${String(err)}`, output: '' };
  }
}

/** Push the execute panel state to the host (no-op in headless contexts). */
function pushExecuteWidget(ctx: PhaseDispatchContext, lines: string[]): void {
  if (ctx.ui === undefined) {
    return;
  }
  ctx.ui.setWidget(JOVALTUS_EXECUTE_WIDGET_KEY, lines);
  ctx.ui.setStatus(JOVALTUS_EXECUTE_STATUS_KEY, 'executing plan');
}

/** Clear the execute panel (used on dispatch failure). */
function clearExecuteWidget(ctx: PhaseDispatchContext): void {
  if (ctx.ui === undefined) {
    return;
  }
  ctx.ui.setWidget(JOVALTUS_EXECUTE_WIDGET_KEY, undefined);
  ctx.ui.setStatus(JOVALTUS_EXECUTE_STATUS_KEY, undefined);
}

/**
 * Execute a parsed plan: batch-major steps (serial between batches, agents
 * within a batch dispatched in parallel), gated by the progress machine.
 */
async function runPlanExecution(
  p: PipelineState,
  plan: ExecutionPlan,
  ctx: PhaseDispatchContext,
): Promise<ToolResult> {
  const agentsById = new Map(plan.batches.flat().map((a) => [a.id, a]));
  const steps = deriveExecutionSteps(plan);
  let progress = createProgress(plan);
  const summaries: string[] = [];
  // Live execute-panel state streamed to the desktop host.
  let widget = planExecuteWidgetInitial(plan);
  pushExecuteWidget(ctx, buildExecuteWidgetLines(widget));
  for (const [stepIndex, step] of steps.entries()) {
    progress = startRunning(progress, step);
    for (const id of step) {
      widget = planExecuteWidgetAgentStart(widget, id);
    }
    pushExecuteWidget(ctx, buildExecuteWidgetLines(widget));
    const dispatched = await Promise.all(
      step.map(async (id) => {
        const agent = agentsById.get(id);
        if (agent === undefined) {
          return { ok: false, message: `agent ${id} missing from the plan`, output: '' };
        }
        return await dispatchAgent(p, agent, ctx);
      }),
    );
    for (const [i, result] of dispatched.entries()) {
      if (!result.ok) {
        clearExecuteWidget(ctx);
        return failPipeline(p, ctx, result.message);
      }
      const id = step[i];
      if (id !== undefined) {
        progress = markDone(progress, id);
        widget = planExecuteWidgetAgentDone(widget, id, stepIndex);
        const firstLine = result.output.trim().split('\n')[0] ?? '';
        summaries.push(`- ${id}: ${firstLine}`);
      }
    }
    pushExecuteWidget(ctx, buildExecuteWidgetLines(widget));
  }
  widget = planExecuteWidgetDone(widget);
  pushExecuteWidget(ctx, buildExecuteWidgetLines(widget));
  jstate.setPhase(p, 'done');
  jstate.finishPipeline(p, true);
  const summary = `executed ${String(summaries.length)} agent(s) in ${String(steps.length)} step(s), mode ${plan.execution_mode}:\n${summaries.join('\n')}`;
  const result = startedResult(p, 'execute', summary);
  return { ...result, details: { ...result.details, plan: executionSummaryDetails(plan) } };
}

/** Resolve a plan session and parse its execution plan for dispatch. */
function resolveExecutionPlan(planId: string): { p: PipelineState; plan: ExecutionPlan } | null {
  const session = jstate.getSession(planId);
  if (session === null || session.tool !== 'plan' || session.status !== 'done') {
    return null;
  }
  const plan = readExecutionPlan(session.run_dir);
  if (plan === null) {
    return null;
  }
  return { p: session, plan };
}

/**
 * The mermaid graph + agent count shown in the execute_plan result, so the
 * run report doubles as the frontend's execution graph source.
 */
function executionSummaryDetails(plan: ExecutionPlan): Record<string, unknown> {
  return {
    execution_mode: plan.execution_mode,
    steps: deriveExecutionSteps(plan),
    mermaid: planToMermaid(plan),
  };
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
  return await runPlanPipeline(p, ctx, dispatchCtx(ctx));
}

async function executePlanHandler(
  params: { plan_id: string },
  ctx: ExtensionContext,
): Promise<ToolResult> {
  const planId = params.plan_id.trim();
  if (!planId) {
    return errorResult('execute_plan requires a plan_id');
  }
  const resolved = resolveExecutionPlan(planId);
  if (resolved === null) {
    const session = jstate.getSession(planId);
    if (session === null) {
      return errorResult(`no plan session found: ${planId}`);
    }
    if (session.tool !== 'plan') {
      return errorResult(`session ${session.id} is not a plan pipeline (tool=${session.tool})`);
    }
    if (session.status !== 'done') {
      return errorResult(
        `plan session ${session.id} is ${session.status} — execute_plan requires a completed plan`,
      );
    }
    return errorResult(`execution-plan.json missing or invalid in ${session.run_dir}`);
  }
  const { p, plan } = resolved;
  const execution = jstate.startPipeline(
    'execute',
    p.run_dir,
    p.user_requirements,
    path.join(p.run_dir, EXECUTION_PLAN_FILENAME),
  );
  return await runPlanExecution(execution, plan, dispatchCtx(ctx));
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
    '- Reuse completed artifacts (prd.md, design.md, execution-plan.json, ...) as-is when valid.\n' +
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
    result = await runPlanPipeline(p, ctx, dctx);
  } else if (p.tool === 'execute') {
    const plan = readExecutionPlan(p.run_dir);
    if (plan === null) {
      return errorResult(
        `cannot resume session ${p.id}: execution-plan.json missing or invalid in ${p.run_dir}`,
      );
    }
    result = await runPlanExecution(p, plan, dctx);
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
  // Plan mode: /planmode command, shift+P (TUI) + shift+tab/mode button
  // (desktop), tool gating for plan / execute_plan, mode persistence.
  registerPlanMode(pi);

  pi.registerTool({
    name: 'plan',
    label: 'Plan',
    description:
      'Draw up a software-engineering implementation plan (plan mode). ' +
      'Runs the Jovaltus plan pipeline: PRD subagent → requirement ' +
      'clarification (human-in-loop) → design subagent → the main agent ' +
      'writes failing property-based tests and the execution plan JSON. ' +
      'Artifacts land in <cwd>/.plan/<date>/<name>/. Requires user_requirements.',
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
    name: 'execute_plan',
    label: 'Execute Plan',
    description:
      'Execute a plan-mode plan by dispatching its subagents. Takes a plan_id ' +
      '(a completed plan session id or its run directory); resolves the ' +
      'session, parses <run_dir>/execution-plan.json, and dispatches the ' +
      'agents per execution_mode (serial / batched / parallel), auto-injecting ' +
      'the PRD + design doc into every agent. Changes stay uncommitted for ' +
      'simplify/review. Plan mode only.',
    promptSnippet: 'Execute a user-approved plan via the Jovaltus pipeline',
    promptGuidelines: [
      'Use execute_plan only after the user has explicitly approved a specific plan.',
    ],
    parameters: Type.Object({
      plan_id: Type.String({ description: 'Plan session id or run directory' }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      void signal;
      void onUpdate;
      return await executePlanHandler(params, ctx);
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
    // Plan waiting: artifact-driven completion — the main agent finishes
    // writing execution-plan.json; advance to done once it parses. A
    // malformed artifact is nudged back; a missing one means the main agent
    // is still writing it (the handoff text already said what to do).
    if (p.tool === 'plan' && p.phase === 'plan_waiting') {
      if (readExecutionPlan(p.run_dir) !== null) {
        jstate.setPhase(p, 'done');
        jstate.finishPipeline(p, true);
        ctx.ui.notify('Jovaltus plan complete', 'info');
        return;
      }
      if (fileExists(path.join(p.run_dir, EXECUTION_PLAN_FILENAME))) {
        pi.sendUserMessage(
          `[Jovaltus] execution-plan.json in ${p.run_dir} does not parse. ` +
            `Fix it to match the schema ` +
            `({ execution_mode: serial|batched|parallel, batches: [[{id, task_prompt}]] }) ` +
            `and the plan pipeline will finish automatically.`,
        );
      }
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
