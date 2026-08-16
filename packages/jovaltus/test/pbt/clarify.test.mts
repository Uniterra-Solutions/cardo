/**
 * Clarification wizard PBT — the Jovaltus human-in-loop requirement
 * clarification (packages/jovaltus/src/clarify.ts).
 *
 * Invariants locked here:
 *  1. When the PRD subagent wrote `questions.json`, the plan pipeline asks
 *     them ONE at a time through `ctx.ui.askQuestions` (the wizard) with the
 *     agent-authored options, then persists `clarify.md` + `clarify.json`
 *     and continues into the design phase.
 *  2. Headless hosts (hasUI false) and hosts without a wizard surface fall
 *     back to legacy per-question `select`/`input` dialogs; a cancelled
 *     dialog writes nothing ("requirements are clear").
 *  3. `readClarifyQuestions` drops malformed entries and returns [] on
 *     missing/unparsable files.
 *  4. The plan pipeline pushes a `jovaltus-plan` progress widget through the
 *     phases and parks it at `done` once plan_waiting is reached.
 *
 * The fake pi backend writes `questions.json` for the prd phase from
 * `JOVALTUS_FAKE_QUESTIONS` (exactly like the real PRD subagent's write
 * tool), so the whole wizard path runs end-to-end without an LLM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import jovaltusFactory from '../../dist/index.js';
import { OTHER_OPTION_LABEL, readClarifyQuestions } from '../../dist/clarify.js';
import {
  buildPlanProgressLines,
  JOVALTUS_PLAN_WIDGET_KEY,
  planProgressCompletePhase,
  planProgressDone,
  planProgressInitial,
  planProgressStartPhase,
} from '../../dist/plan-pipeline-progress.js';
import {
  captureApi,
  clearFakeEnv,
  freshFakeEnv,
  makeCtx,
  makeTmpDir,
  setAgentDir,
} from '../helpers/stub-api.mts';
import type { CapturedTool, StubApi, ToolCallResult } from '../helpers/stub-api.mts';

function setupRun(
  t: { after(fn: () => void): void },
  envOverrides: Record<string, string> = {},
): { tmp: string; cwd: string; stub: StubApi } {
  const tmp = makeTmpDir();
  t.after(() => {
    clearFakeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });
  const cwd = path.join(tmp, 'repo');
  mkdirSync(cwd, { recursive: true });
  setAgentDir(path.join(tmp, 'agent'));
  freshFakeEnv(tmp, { JOVALTUS_FAKE_OUTPUT: 'phase executed', ...envOverrides });
  const stub = captureApi();
  jovaltusFactory(stub.api);
  return { tmp, cwd, stub };
}

function requireTool(stub: StubApi, name: string): CapturedTool {
  const tool = stub.tools.get(name);
  assert.ok(tool !== undefined, `factory registered ${name}`);
  return tool;
}

const REQUIREMENTS = 'Debug feature alpha beta gamma delta';

const QUESTIONS = [
  {
    question: 'Where should the mode live?',
    options: ['Own package (packages/debug)', 'Inside packages/general'],
  },
  {
    question: 'Does the desktop need a picker UI?',
    options: ['Yes, full mode picker', 'No, command/shortcut is enough'],
  },
];

function questionsEnv(): Record<string, string> {
  return { JOVALTUS_FAKE_QUESTIONS: JSON.stringify({ questions: QUESTIONS }) };
}

async function runPlanWithQuestions(
  stub: StubApi,
  cwd: string,
  ctxOptions: Parameters<typeof makeCtx>[1],
): Promise<{ result: ToolCallResult; runDir: string; call: ReturnType<typeof makeCtx> }> {
  const tool = requireTool(stub, 'plan');
  const call = makeCtx(cwd, ctxOptions);
  const result = (await tool.execute(
    'call-1',
    { user_requirements: REQUIREMENTS },
    undefined,
    undefined,
    call.ctx,
  )) as ToolCallResult;
  assert.ok(!result.details['isError'], `plan succeeds: ${result.content[0]?.text}`);
  return { result, runDir: String(result.details['run_dir']), call };
}

test('plan: asks agent-authored questions via the wizard, persists clarify.md + clarify.json, pushes plan progress', async (t) => {
  const { cwd, stub } = setupRun(t, questionsEnv());
  const { runDir, call } = await runPlanWithQuestions(stub, cwd, {
    hasUI: true,
    askAnswers: ['Own package (packages/debug)', 'No, command/shortcut is enough'],
  });

  // The wizard was asked exactly once, with the agent-authored questions.
  assert.equal(call.askQuestionsCalls.length, 1);
  assert.equal(call.askQuestionsCalls[0]?.title, 'Jovaltus 需求釐清');
  assert.deepEqual(
    call.askQuestionsCalls[0]?.questions.map((q) => ({ question: q.question, options: q.options })),
    QUESTIONS,
  );

  // The answers are persisted in both human-readable and structured form.
  const clarifyMd = readFileSync(path.join(runDir, 'clarify.md'), 'utf8');
  assert.match(clarifyMd, /### Q: Where should the mode live\?/);
  assert.match(clarifyMd, /Own package \(packages\/debug\)/);
  assert.match(clarifyMd, /No, command\/shortcut is enough/);
  const clarifyJson = JSON.parse(readFileSync(path.join(runDir, 'clarify.json'), 'utf8')) as {
    questions: { question: string; answer: string }[];
  };
  assert.deepEqual(clarifyJson.questions, [
    { question: QUESTIONS[0]?.question ?? '', answer: 'Own package (packages/debug)' },
    { question: QUESTIONS[1]?.question ?? '', answer: 'No, command/shortcut is enough' },
  ]);

  // The plan progress widget was pushed and parked at done (plan_waiting).
  const planPushes = call.widgets.filter((w) => w.key === JOVALTUS_PLAN_WIDGET_KEY);
  assert.ok(
    planPushes.length >= 4,
    `progress pushed through the phases: ${String(planPushes.length)}`,
  );
  const last = planPushes.at(-1);
  assert.ok(last?.lines !== undefined);
  let expected = planProgressInitial();
  expected = planProgressStartPhase(expected, 'prd');
  expected = planProgressCompletePhase(expected, 'prd');
  expected = planProgressStartPhase(expected, 'clarify');
  expected = planProgressCompletePhase(expected, 'clarify');
  expected = planProgressStartPhase(expected, 'design');
  expected = planProgressCompletePhase(expected, 'design');
  expected = planProgressCompletePhase(expected, 'plan');
  expected = planProgressDone(expected);
  assert.deepEqual(last.lines, buildPlanProgressLines(expected));
});

test('plan: no questions.json → clarification skipped, no files written', async (t) => {
  const { cwd, stub } = setupRun(t);
  const { runDir, call } = await runPlanWithQuestions(stub, cwd, {
    hasUI: true,
    askAnswers: ['anything'],
  });
  assert.equal(call.askQuestionsCalls.length, 0, 'no wizard call without questions.json');
  assert.ok(!existsSync(path.join(runDir, 'clarify.md')), 'no clarify.md');
  assert.ok(!existsSync(path.join(runDir, 'clarify.json')), 'no clarify.json');
});

test('plan: cancelled wizard writes nothing but the pipeline continues', async (t) => {
  const { cwd, stub } = setupRun(t, questionsEnv());
  const { runDir, call } = await runPlanWithQuestions(stub, cwd, { hasUI: true }); // askAnswers undefined → cancel
  assert.equal(call.askQuestionsCalls.length, 1);
  assert.ok(!existsSync(path.join(runDir, 'clarify.md')), 'cancelled → no clarify.md');
});

test('plan: legacy hosts without the wizard use per-question select + Other input', async (t) => {
  const { cwd, stub } = setupRun(t, questionsEnv());
  const { runDir, call } = await runPlanWithQuestions(stub, cwd, {
    hasUI: true,
    askQuestionsAvailable: false,
    selectAnswer: OTHER_OPTION_LABEL,
    inputAnswer: 'my own answer',
  });
  assert.equal(call.askQuestionsCalls.length, 0, 'legacy host has no wizard');

  const clarifyMd = readFileSync(path.join(runDir, 'clarify.md'), 'utf8');
  assert.match(clarifyMd, /my own answer/);
  const clarifyJson = JSON.parse(readFileSync(path.join(runDir, 'clarify.json'), 'utf8')) as {
    questions: { answer: string }[];
  };
  assert.equal(clarifyJson.questions[0]?.answer, 'my own answer');
});

test('readClarifyQuestions: parses valid entries, drops malformed ones, [] on missing file', () => {
  const tmp = makeTmpDir();
  try {
    // Missing file → [].
    assert.deepEqual(readClarifyQuestions(tmp), []);

    // Valid file passes through unchanged.
    writeFileSync(path.join(tmp, 'questions.json'), JSON.stringify({ questions: QUESTIONS }));
    assert.deepEqual(readClarifyQuestions(tmp), QUESTIONS);

    // Malformed entries dropped; blank options ignored.
    writeFileSync(
      path.join(tmp, 'questions.json'),
      JSON.stringify({
        questions: [
          { question: '  ', options: ['a'] },
          { question: 'ok', options: [] },
          { question: 'still ok', options: ['a', '', 'b'] },
          { question: 'no options' },
          'not-an-object',
          { question: 'good', options: ['x'] },
        ],
      }),
    );
    assert.deepEqual(readClarifyQuestions(tmp), [
      { question: 'still ok', options: ['a', 'b'] },
      { question: 'good', options: ['x'] },
    ]);

    // Unparsable file → [].
    writeFileSync(path.join(tmp, 'questions.json'), 'not json');
    assert.deepEqual(readClarifyQuestions(tmp), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
