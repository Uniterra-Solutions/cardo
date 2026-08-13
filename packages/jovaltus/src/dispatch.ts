/**
 * Phase dispatch: run one pipeline phase subagent as a child `pi` process.
 *
 * Ported from the Hermes plugin's `subagent_lifecycle` dispatch. Following
 * pi's official subagent extension example
 * (`examples/extensions/subagent/`), each phase runs in an isolated child
 * `pi --mode json -p --no-session` process whose system prompt is the
 * rendered phase prompt (appended via a temp file so special characters
 * survive the command line). `--no-extensions` prevents the child from
 * recursively loading this extension (no agent_settled re-dispatch inside
 * the child, no shared state file contention).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PhaseResult {
  exitCode: number;
  output: string;
  /** stderr tail, for diagnostics on failure */
  error: string;
}

/** Tools the phase subagents get: the coding built-ins, no extension tools. */
const PHASE_TOOLS = 'read,bash,edit,write,grep,find,ls';

function existsSync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const cliPath = process.env.PI_CLI_PATH;
  if (cliPath) {
    // Embedded host (e.g. the cardo desktop app): run the pi CLI entry under
    // the current runtime. A `.js` path launches with process.execPath
    // (Electron becomes node via ELECTRON_RUN_AS_NODE at the spawn site);
    // anything else (a compiled `pi` binary) is executed directly.
    if (/\.(c|m)?js$/i.test(cliPath)) {
      return { command: process.execPath, args: [cliPath, ...args] };
    }
    return { command: cliPath, args };
  }
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: 'pi', args };
}

interface RunPhaseOptions {
  cwd: string;
  /** The rendered phase prompt (system prompt for the child). */
  prompt: string;
  /** The task text passed as the final positional argument. */
  task: string;
  /** Model pattern ("provider/id") to inherit from the parent, or null. */
  model: string | null;
  /** Thinking level to inherit ("off"|"low"|"medium"|"high"|...), or null. */
  thinkingLevel: string | null;
  /** Abort signal forwarded to the child process. */
  signal?: AbortSignal;
  /** Progress callback: receive each assistant text delta chunk. */
  onText?: (text: string) => void;
}

/**
 * Run one pipeline phase in a child pi process and wait for it to finish.
 * Returns the child's exit code, the final assistant text output, and a
 * stderr tail for diagnostics.
 */
export async function runPhase(options: RunPhaseOptions): Promise<PhaseResult> {
  const { cwd, prompt, task, model, thinkingLevel, signal, onText } = options;

  const args: string[] = ['--mode', 'json', '-p', '--no-session', '--no-extensions'];
  args.push('--tools', PHASE_TOOLS);
  if (model) {
    args.push('--model', model);
  }
  if (thinkingLevel && thinkingLevel !== 'off') {
    args.push('--thinking', thinkingLevel);
  }

  // The phase prompt travels as a temp file appended to the system prompt —
  // the official example's pattern, avoids shell quoting issues.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jovaltus-phase-'));
  const promptFile = path.join(tmpDir, 'prompt.md');
  writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
  args.push('--append-system-prompt', promptFile);
  args.push(task);

  const invocation = getPiInvocation(args);
  // When running a `.js` pi entry under an embedded Electron host, the app
  // binary must be launched in node mode for the child to be a plain node
  // process. Harmless no-op under node/bun.
  const env =
    invocation.command === process.execPath && process.env.PI_CLI_PATH
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : process.env;

  return new Promise<PhaseResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const finish = (code: number): void => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      exitCode = code;
      resolve({
        exitCode,
        output: extractFinalOutput(stdout),
        error: stderr.slice(-4000),
      });
    };

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      const delta = extractAssistantTextDelta(stdout);
      if (delta) {
        onText?.(delta);
      }
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      finish(code ?? 1);
    });
    proc.on('error', (err) => {
      stderr += `\nspawn error: ${String(err)}`;
      finish(1);
    });

    if (signal) {
      const killProc = (): void => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      };
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener('abort', killProc, { once: true });
      }
    }
  });
}

interface JsonlEvent {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: JsonlContent[];
  };
}

/** Parse the tail of a JSONL stdout buffer into events (bounded cost). */
function parseJsonlTail(stdout: string): JsonlEvent[] {
  const lines = stdout.split('\n');
  const events: JsonlEvent[] = [];
  for (const line of lines.slice(-200)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as JsonlEvent);
    } catch {
      events.push({});
    }
  }
  return events;
}

interface JsonlContent {
  type?: unknown;
  text?: unknown;
}

function isTextContent(p: JsonlContent): p is { type: 'text'; text: string } {
  return p.type === 'text' && typeof p.text === 'string';
}

/** The last assistant text message from a `pi --mode json` stdout buffer. */
function extractAssistantTextDelta(stdout: string): string {
  const events = parseJsonlTail(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt?.type === 'message_end' && evt.message?.role === 'assistant') {
      const content = evt.message.content;
      if (Array.isArray(content)) {
        const texts = content.filter(isTextContent).map((p) => p.text);
        if (texts.length > 0) {
          return texts.join('\n');
        }
      }
    }
  }
  return '';
}

/** The final assistant output: last assistant message's text in the stream. */
function extractFinalOutput(stdout: string): string {
  return extractAssistantTextDelta(stdout);
}
