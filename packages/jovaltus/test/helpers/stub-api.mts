/**
 * Stubs for the pi extension surface (`ExtensionAPI` / `ExtensionContext`),
 * used by the integrated PBT suite to drive the jovaltus extension's tool
 * handlers and event hooks against the fake `pi` backend (fake-pi.mjs).
 *
 * The factory (`src/index.ts`) is invoked with a capturing stub: registered
 * tools and event handlers are recorded so tests can invoke them with
 * synthetic contexts and assert the resulting pipeline state, notifications,
 * and user messages.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineState } from '../../dist/state.js';

/** Absolute path to the fake pi backend (dispatch picks it up via PI_CLI_PATH). */
export const FAKE_PI_PATH = fileURLToPath(new URL('../fixtures/fake-pi.mjs', import.meta.url));

/** Environment keys consumed by the fake backend (cleared between tests). */
export const FAKE_ENV_KEYS: readonly string[] = [
  'PI_CLI_PATH',
  'JOVALTUS_FAKE_LOG',
  'JOVALTUS_FAKE_OUTPUT',
  'JOVALTUS_FAKE_EXIT',
  'JOVALTUS_FAKE_FAIL_ON',
  'JOVALTUS_FAKE_SLOW_MS',
  'JOVALTUS_FAKE_VERDICT_FILE',
  'JOVALTUS_FAKE_FINDINGS',
];

/** Point the fake backend at a fresh log file; return the log path. */
export function freshFakeEnv(dir: string, overrides: Record<string, string> = {}): string {
  const logFile = path.join(dir, 'fake.log');
  const env: Record<string, string> = { ...overrides, JOVALTUS_FAKE_LOG: logFile };
  for (const key of FAKE_ENV_KEYS) {
    if (key in env) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }
  process.env.PI_CLI_PATH = FAKE_PI_PATH;
  return logFile;
}

/** Remove all fake-backend env keys (test isolation). */
export function clearFakeEnv(): void {
  for (const key of FAKE_ENV_KEYS) {
    delete process.env[key];
  }
}

/** Shape of the object a tool handler resolves. */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

/** Build a valid PipelineState for prompt/dispatch tests. */
export function makePipelineState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    id: 'session-1',
    run_dir: '/repo/.plan/20260101/feature',
    tool: 'plan',
    phase: 'prd',
    status: 'running',
    user_requirements: 'Build a feature',
    plan_path: null,
    loop_iteration: 0,
    verdict: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    error: null,
    pid: 1234,
    created_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    ...overrides,
  };
}

/** Tool captured from `pi.registerTool`, with a test-friendly execute shape. */
export interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((text: string) => void) | undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

export interface CapturedNotification {
  title: string;
  level: 'error' | 'info' | 'warning';
}

export interface CapturedStatus {
  key: string;
  text: string | undefined;
}

export interface CapturedWidget {
  key: string;
  lines: readonly string[] | undefined;
  options: Record<string, unknown> | undefined;
}

export type StubHandler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Capture surface returned by `captureApi` (the `api` field is the stub). */
export interface StubApi {
  api: ExtensionAPI;
  tools: Map<string, CapturedTool>;
  /** Event handlers, in registration order (pi supports multiple per event). */
  handlers: Map<string, StubHandler[]>;
  commands: Map<string, unknown>;
  shortcuts: string[];
  flags: Map<string, { type: string; default: unknown }>;
  flagValues: Map<string, unknown>;
  activeTools: string[];
  entries: Array<{ type: string; customType: string; data: unknown }>;
  sentMessages: string[];
}

/** Last-registered handler for an event (the usual single-handler case). */
export function handlerFor(stub: StubApi, event: string): StubHandler | undefined {
  const list = stub.handlers.get(event);
  return list?.[list.length - 1];
}

/** Build an ExtensionAPI stub that records registrations and messages. */
export function captureApi(): StubApi {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, StubHandler[]>();
  const commands = new Map<string, unknown>();
  const shortcuts: string[] = [];
  const flags = new Map<string, { type: string; default: unknown }>();
  const flagValues = new Map<string, unknown>();
  const activeTools: string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sentMessages: string[] = [];
  const api = {
    registerTool: (tool: CapturedTool): void => {
      tools.set(tool.name, tool);
    },
    on: (event: string, handler: unknown): void => {
      const list = handlers.get(event) ?? [];
      list.push(handler as StubHandler);
      handlers.set(event, list);
    },
    sendUserMessage: (content: string | unknown[]): void => {
      sentMessages.push(typeof content === 'string' ? content : JSON.stringify(content));
    },
    registerCommand: (name: string, definition: unknown): void => {
      commands.set(name, definition);
    },
    registerShortcut: (shortcut: string): void => {
      shortcuts.push(shortcut);
    },
    registerFlag: (name: string, definition: { type: string; default: unknown }): void => {
      flags.set(name, definition);
      flagValues.set(name, definition.default);
    },
    getFlag: (name: string): unknown => flagValues.get(name),
    setFlag: (name: string, value: unknown): void => {
      flagValues.set(name, value);
    },
    getActiveTools: (): string[] => [...activeTools],
    setActiveTools: (names: string[]): void => {
      activeTools.length = 0;
      activeTools.push(...names);
    },
    appendEntry: (type: string, data: unknown): void => {
      entries.push({ type: 'custom', customType: type, data });
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    tools,
    handlers,
    commands,
    shortcuts,
    flags,
    flagValues,
    activeTools,
    entries,
    sentMessages,
  };
}

export interface StubCtx {
  ctx: ExtensionContext;
  notifications: CapturedNotification[];
  statuses: CapturedStatus[];
  widgets: CapturedWidget[];
}

export interface MakeCtxOptions {
  /** model for `ctx.model`; null → undefined; omitted → test model */
  model?: { provider: string; id: string } | null;
  /** thinking level; null → undefined; omitted → 'high' */
  thinking?: string | null;
  signal?: AbortSignal;
  /** session entries returned by ctx.sessionManager.getEntries() */
  sessionEntries?: unknown[];
}

/** Build an ExtensionContext backed by `cwd`, capturing ui.notify calls. */
export function makeCtx(cwd: string, opts: MakeCtxOptions = {}): StubCtx {
  const notifications: CapturedNotification[] = [];
  const statuses: CapturedStatus[] = [];
  const widgets: CapturedWidget[] = [];
  const ctx = {
    ui: {
      notify: (title: string, level: 'error' | 'info' | 'warning'): void => {
        notifications.push({ title, level });
      },
      setStatus: (key: string, text: string | undefined): void => {
        statuses.push({ key, text });
      },
      setWidget: (
        key: string,
        lines: readonly string[] | undefined,
        options?: Record<string, unknown>,
      ): void => {
        widgets.push({ key, lines, options });
      },
    },
    mode: 'json',
    hasUI: false,
    cwd,
    sessionManager: { getEntries: (): unknown[] => opts.sessionEntries ?? [] },
    modelRegistry: {},
    model: opts.model === null ? undefined : (opts.model ?? { provider: 'test', id: 'model-1' }),
    scopedModels: [],
    thinkingLevel:
      opts.thinking === undefined ? 'high' : opts.thinking === null ? undefined : opts.thinking,
    isIdle: (): boolean => true,
    isProjectTrusted: (): boolean => true,
    signal: opts.signal,
    abort: (): void => {},
    hasPendingMessages: (): boolean => false,
    shutdown: (): void => {},
    getContextUsage: (): undefined => undefined,
    compact: (): void => {},
    getSystemPrompt: (): string => '',
  } as unknown as ExtensionContext;
  return { ctx, notifications, statuses, widgets };
}

/** Create a fresh temp dir for one test (agent dir / cwd / artifacts). */
export function makeTmpDir(prefix = 'jovaltus-pbt-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point the pi agent dir (state persistence) at `dir` for the current process. */
export function setAgentDir(dir: string): void {
  process.env.PI_CODING_AGENT_DIR = dir;
}

/** Write a verdict plan file consumed by the fake pi across dispatches. */
export function writeVerdictPlan(dir: string, plan: string[]): string {
  const file = path.join(dir, 'verdict-plan.json');
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

/** Write a verdict plan AND wire it into the fake backend env. */
export function useVerdictPlan(dir: string, plan: string[]): string {
  const file = writeVerdictPlan(dir, plan);
  process.env.JOVALTUS_FAKE_VERDICT_FILE = file;
  return file;
}
