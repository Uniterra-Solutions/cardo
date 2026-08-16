/**
 * Fake `pi` backend for Jovaltus integrated PBT.
 *
 * The jovaltus extension dispatches each pipeline phase to a child
 * `pi --mode json -p --no-session --no-extensions` process (see
 * `src/dispatch.ts`). This fixture emulates the pi CLI contract that the
 * extension depends on, WITHOUT a model or provider:
 *
 *   - accepts the exact argument shape the extension builds
 *     (--mode json -p --no-session --no-extensions --tools ... [--model M]
 *     [--thinking T] --append-system-prompt <file> <task>)
 *   - reads the rendered phase prompt from the temp file
 *   - for review phases (simplify/review), writes `<run_dir>/verdict.json`
 *     exactly like the real reviewer subagent would, driven by a verdict
 *     PLAN file (one verdict consumed per dispatch, so multi-round fix loops
 *     are deterministic)
 *   - emits `pi --mode json` style JSONL events (message_start /
 *     message_update / message_end with the assistant text)
 *   - logs every invocation to JOVALTUS_FAKE_LOG for contract assertions
 *
 * Environment contract:
 *   PI_CLI_PATH                 set by the test to this file (dispatch picks it up)
 *   JOVALTUS_FAKE_VERDICT_FILE  path to a JSON array of verdicts
 *                               ('pass' | 'fix' | 'missing' | 'invalid'),
 *                               consumed front-to-back across dispatches
 *   JOVALTUS_FAKE_FINDINGS      findings text for 'fix' verdicts (optional)
 *   JOVALTUS_FAKE_OUTPUT        assistant text emitted (optional)
 *   JOVALTUS_FAKE_EXIT          child exit code (default 0)
 *   JOVALTUS_FAKE_FAIL_ON       comma-separated phases that exit 1 (optional)
 *   JOVALTUS_FAKE_SLOW_MS       sleep before emitting (for abort tests)
 *   JOVALTUS_FAKE_LOG           file to append one JSON line per invocation
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const VERDICT_TYPES = ['pass', 'fix', 'missing', 'invalid'];

function parseArgs(argv) {
  const opts = { appendSystemPrompt: null, model: null, thinking: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--append-system-prompt') {
      opts.appendSystemPrompt = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--model') {
      opts.model = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--thinking') {
      opts.thinking = argv[i + 1] ?? null;
      i += 1;
    } else if (typeof arg === 'string' && arg.startsWith('-')) {
      // bare flag (--mode, -p, --no-session, --no-extensions, --tools)
    } else {
      positionals.push(arg);
    }
  }
  return { opts, task: positionals.join(' ') };
}

function readPrompt(file) {
  if (!file) {
    return '';
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function markerInfo(prompt) {
  // tool: letters/underscore; phase: the plan agent id charset (may contain
  // digits and hyphens, e.g. execute_plan agents like "db-schema")
  const match = /\[jovaltus-pipeline:([a-z_]+):([a-z0-9_-]+)\]/.exec(prompt);
  if (!match) {
    return { tool: null, phase: null };
  }
  return { tool: match[1], phase: match[2] };
}

function extractRunDir(task, prompt) {
  for (const text of [task, prompt]) {
    const match = /## Run directory\n(.+)/.exec(text);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function consumeVerdict(planFile) {
  let plan = [];
  try {
    const parsed = JSON.parse(readFileSync(planFile, 'utf8'));
    if (Array.isArray(parsed)) {
      plan = parsed;
    }
  } catch {
    return null;
  }
  if (plan.length === 0) {
    return null;
  }
  const next = plan[0];
  writeFileSync(planFile, JSON.stringify(plan.slice(1)));
  return typeof next === 'string' ? next : null;
}

function writeVerdict(runDir, verdict, findings) {
  if (verdict === 'missing') {
    return;
  }
  const payload = verdict === 'invalid' ? { verdict: 'banana' } : { verdict, findings };
  writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify(payload, null, 2));
}

function logInvocation(entry) {
  const logFile = process.env.JOVALTUS_FAKE_LOG;
  if (!logFile) {
    return;
  }
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

const argv = process.argv.slice(2);
const { opts, task } = parseArgs(argv);
const prompt = readPrompt(opts.appendSystemPrompt);
const { tool, phase } = markerInfo(prompt);
const runDir = extractRunDir(task, prompt);

// Failure injection: certain phases exit non-zero (stderr tail becomes the
// dispatch error text).
const failOn = (process.env.JOVALTUS_FAKE_FAIL_ON ?? '').split(',').filter(Boolean);
if (phase && failOn.includes(phase)) {
  process.stderr.write(`fake pi: failing on phase ${phase}\n`);
  logInvocation({ argv, tool, phase, runDir, prompt, output: '', exitCode: 1 });
  process.exit(1);
}

// Reviewer behavior: consume one verdict and write verdict.json like the real
// reviewer subagent would (only review phases read verdicts).
if (phase === 'simplify' || phase === 'review') {
  const planFile = process.env.JOVALTUS_FAKE_VERDICT_FILE;
  if (planFile && runDir) {
    const verdict = consumeVerdict(planFile);
    if (verdict && VERDICT_TYPES.includes(verdict)) {
      writeVerdict(runDir, verdict, process.env.JOVALTUS_FAKE_FINDINGS ?? 'fake defect found');
    }
  }
}

// PRD author behavior: write questions.json like the real PRD subagent would
// (the env holds the exact JSON file content), so the clarify wizard path can
// be exercised end-to-end.
if (phase === 'prd' && runDir) {
  const questions = process.env.JOVALTUS_FAKE_QUESTIONS;
  if (questions !== undefined) {
    writeFileSync(path.join(runDir, 'questions.json'), questions, 'utf8');
  }
}

const output =
  process.env.JOVALTUS_FAKE_OUTPUT ?? `phase ${tool ?? '?'}/${phase ?? '?'} executed (fake pi)`;
const slowMs = Number(process.env.JOVALTUS_FAKE_SLOW_MS ?? 0);

logInvocation({
  argv,
  tool,
  phase,
  runDir,
  promptFile: opts.appendSystemPrompt,
  prompt,
  output,
  cwd: process.cwd(),
  promptMode: opts.appendSystemPrompt
    ? (() => {
        try {
          return statSync(opts.appendSystemPrompt).mode & 0o777;
        } catch {
          return null;
        }
      })()
    : null,
  exitCode: Number(process.env.JOVALTUS_FAKE_EXIT ?? 0),
});

const emit = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
if (slowMs > 0) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(slowMs);
}
emit({
  type: 'message_update',
  message: { role: 'assistant', content: [{ type: 'text', text: output.slice(0, 5) }] },
});
emit({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: output }] },
});

process.exit(Number(process.env.JOVALTUS_FAKE_EXIT ?? 0));
