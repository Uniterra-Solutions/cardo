/**
 * Integrated PBT — the child-process dispatch contract (`dist/dispatch.js`
 * runPhase against the fake `pi` backend).
 *
 * These properties exercise the REAL spawn path — actual child processes,
 * actual temp prompt files, actual stdout/stderr/exit codes — so they lock
 * the extension ↔ pi-backend interaction contract:
 *  1. The child is invoked exactly as the official subagent example does:
 *     --mode json -p --no-session --no-extensions --tools <the 7 coding
 *     tools> [--model M] [--thinking T] --append-system-prompt <file> <task>.
 *     `--no-extensions` is the recursion-prevention invariant: a child must
 *     never load the jovaltus extension itself.
 *  2. The prompt file the child reads contains exactly the rendered prompt,
 *     with restrictive 0600 permissions.
 *  3. The task is the last positional argument; cwd is forwarded; model and
 *     thinking level are forwarded only when provided.
 *  4. Output contract: the final assistant text becomes result.output and is
 *     streamed to onText (last delta == output); exit codes and stderr tail
 *     propagate; an aborted run is killed (non-zero exit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { renderPrompt } from '../../dist/prompts.js';
import { runPhase } from '../../dist/dispatch.js';
import { clearFakeEnv, freshFakeEnv, makePipelineState, makeTmpDir } from '../helpers/stub-api.mts';

interface FakeLogEntry {
  argv: string[];
  tool: string | null;
  phase: string | null;
  runDir: string | null;
  promptFile: string | null;
  prompt: string;
  output: string;
  cwd: string;
  promptMode: number | null;
  exitCode: number;
}

function readFakeLog(logFile: string): FakeLogEntry[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

test('runPhase: child args match the subagent dispatch contract', async () => {
  const dir = makeTmpDir();
  try {
    const logFile = freshFakeEnv(dir, { JOVALTUS_FAKE_OUTPUT: 'final answer text' });
    const cwd = path.join(dir, 'repo');
    mkdirSync(cwd, { recursive: true });
    const prompt = renderPrompt(
      makePipelineState({ tool: 'review', phase: 'review' }),
      'review',
      cwd,
    );
    const result = await runPhase({
      cwd,
      prompt,
      task: '## Run directory\n/tmp/run\n\nTask: execute the phase described above.',
      model: 'test/model-1',
      thinkingLevel: 'high',
    });
    assert.equal(result.exitCode, 0);
    const [entry] = readFakeLog(logFile);
    assert.ok(entry !== undefined);
    const args = entry.argv;
    // Flag contract.
    for (const flag of ['--mode', 'json', '-p', '--no-session', '--no-extensions']) {
      assert.ok(args.includes(flag), `args include ${flag}`);
    }
    assert.ok(args.includes('--tools'), 'args include --tools');
    assert.equal(args[args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls');
    // Model/thinking forwarding.
    assert.equal(args[args.indexOf('--model') + 1], 'test/model-1');
    assert.equal(args[args.indexOf('--thinking') + 1], 'high');
    // Prompt travels as a temp file; task is last.
    assert.ok(args.includes('--append-system-prompt'));
    assert.equal(
      args[args.length - 1],
      '## Run directory\n/tmp/run\n\nTask: execute the phase described above.',
      'task is the last positional',
    );
    assert.ok(entry.promptFile !== null && entry.promptFile.endsWith('prompt.md'));
    // Prompt file is read-only for the owner (0600).
    assert.equal(entry.promptMode, 0o600);
    // cwd forwarded (compare via realpath: /var is a symlink to /private/var).
    assert.equal(entry.cwd, realpathSync(cwd));
    // The prompt the child read is exactly the rendered prompt.
    assert.equal(entry.prompt, prompt);
    // Output contract: final assistant text is the result output.
    assert.equal(result.output, 'final answer text');
  } finally {
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPhase: no model/thinking when not provided', async () => {
  const dir = makeTmpDir();
  try {
    const logFile = freshFakeEnv(dir);
    const result = await runPhase({
      cwd: dir,
      prompt: 'prompt text',
      task: 'do the phase',
      model: null,
      thinkingLevel: null,
    });
    assert.equal(result.exitCode, 0);
    const [entry] = readFakeLog(logFile);
    assert.ok(entry !== undefined);
    assert.ok(!entry.argv.includes('--model'), 'no --model flag');
    assert.ok(!entry.argv.includes('--thinking'), 'no --thinking flag');
  } finally {
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPhase: onText streams the final assistant text (last delta == output)', async () => {
  const dir = makeTmpDir();
  try {
    freshFakeEnv(dir, { JOVALTUS_FAKE_OUTPUT: 'streamed answer' });
    const deltas: string[] = [];
    const result = await runPhase({
      cwd: dir,
      prompt: 'prompt text',
      task: 'do the phase',
      model: null,
      thinkingLevel: null,
      onText: (text: string) => {
        deltas.push(text);
      },
    });
    assert.equal(result.output, 'streamed answer');
    assert.ok(deltas.length > 0, 'onText receives at least one delta');
    assert.equal(deltas[deltas.length - 1], 'streamed answer');
  } finally {
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPhase: exit codes and stderr tail propagate', async () => {
  const dir = makeTmpDir();
  try {
    freshFakeEnv(dir, { JOVALTUS_FAKE_EXIT: '3' });
    const result = await runPhase({
      cwd: dir,
      prompt: 'prompt text',
      task: 'do the phase',
      model: null,
      thinkingLevel: null,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.output, 'phase ?/? executed (fake pi)');
  } finally {
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPhase: a pre-aborted signal kills the child (non-zero exit)', async () => {
  const dir = makeTmpDir();
  try {
    freshFakeEnv(dir, { JOVALTUS_FAKE_SLOW_MS: '500' });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 100);
    const result = await runPhase({
      cwd: dir,
      prompt: 'prompt text',
      task: 'do the phase',
      model: null,
      thinkingLevel: null,
      signal: controller.signal,
    });
    clearTimeout(abortTimer);
    assert.notEqual(result.exitCode, 0, 'aborted child exits non-zero');
  } finally {
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPhase: task text carrying the run directory reaches the backend', async () => {
  const dir = makeTmpDir();
  try {
    const runDir = path.join(dir, '.plan', '20260101', 'review');
    const logFile = freshFakeEnv(dir, { JOVALTUS_FAKE_OUTPUT: 'reviewed' });
    const result = await runPhase({
      cwd: dir,
      prompt: 'phase prompt',
      task: `## Repo root\n${dir}\n## Run directory\n${runDir}\n## Pipeline phase\nreview\n## Plan path\n\n\nTask: execute the phase described above.`,
      model: null,
      thinkingLevel: null,
    });
    assert.equal(result.exitCode, 0);
    const [entry] = readFakeLog(logFile);
    assert.ok(entry !== undefined);
    assert.equal(entry.runDir, runDir, 'backend locates the run directory from the task');
  } finally {
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});
