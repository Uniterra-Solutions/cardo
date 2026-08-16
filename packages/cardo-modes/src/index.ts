/**
 * Cardo session modes as a DeepSeek Harness plugin.
 *
 * Two mode surfaces, one pure core (`mode-core.ts`):
 * - **plan mode** — native `ctx.planMode` (`/plan` + `exit_plan_mode`
 *   approval); this plugin only exports the shared mode vocabulary so the
 *   desktop UI can show standard/plan/debug consistently.
 * - **debug mode** — this package's own plugin, mirroring the plan-mode
 *   domain: logged `debug/mode` state, a `debug:policy` prompt section
 *   while active, and a `/debug` command to toggle it live.
 *
 * The bundle (`cordis.patch.yml`) inserts the debug controller row; the
 * plan-mode controller is part of `dsh-base`, so a profile that lists
 * `@cardo/cardo-modes` gets both modes without extra wiring.
 */

import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { DEBUG_MODE_NOTE } from './mode-core.js';
import { foldDebugMode } from './debug-state.js';

/** Configuration accepted by the debug-mode controller. */
export interface DebugModeConfig {
  /** The guidance section rendered while debug mode is active. */
  readonly section?: string;
}

/** Resolve and validate debug-mode config; unknown keys fail loud. */
export function resolveDebugModeConfig(config: unknown): Required<DebugModeConfig> {
  const record =
    config === null || typeof config !== 'object' ? {} : (config as Record<string, unknown>);
  const section = record['section'];
  const resolved = section === undefined ? DEBUG_MODE_NOTE : section;
  if (typeof resolved !== 'string') {
    throw new Error('DebugModeConfig needs a string `section`');
  }
  if (resolved.trim() === '') {
    throw new Error('DebugModeConfig needs a non-empty `section`');
  }
  const unknown = Object.keys(record).filter((key) => key !== 'section');
  if (unknown.length > 0) {
    throw new Error(
      `DebugModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section }`,
    );
  }
  return { section: resolved };
}

/** The durable `debug/mode` event type name. */
export const DEBUG_MODE_EVENT = 'debug/mode' as const;

/** The prompt section name contributed by this plugin. */
export const DEBUG_POLICY_SECTION = 'debug:policy' as const;

/** The command name that toggles debug mode. */
export const DEBUG_COMMAND = 'debug' as const;

/**
 * `ctx.cardoDebugMode`: owns logged debug-mode state, applies selected state
 * at step start, and contributes the `debug:policy` section plus the
 * `/debug` command. Mirrors the plan-mode controller contract
 * (`get`/`set` + `committed | queued | cancelled | noop`).
 */
export class DebugModeController extends Service {
  static inject = ['systemPrompt'];

  /** Validated deployment-owned guidance. */
  private readonly section: string;

  /** Latest selection per session awaiting the next accepted in-turn pre-step. */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>();

  constructor(ctx: Context, config: DebugModeConfig = {}) {
    super(ctx, 'cardoDebugMode');
    this.section = resolveDebugModeConfig(config).section;

    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      const pending = this.pendingIntents.get(agent.session);
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision;
      const narration = this.narration(agent.session, pending.active);
      try {
        this.onBoundary(agent.session);
      } catch (error) {
        ctx.logger.warn(
          'cardo-modes: failed to append selected debug mode at step start: %o',
          error,
        );
        return decision;
      }
      return !pending.narrate || narration === undefined
        ? decision
        : { ...decision, messages: [...decision.messages, narration] };
    });

    ctx.systemPrompt.section({
      name: DEBUG_POLICY_SECTION,
      order: 50,
      text: (context) => {
        if (context.agent === undefined) return '';
        const pending = this.pendingIntents.get(context.agent.session);
        return (pending?.active ?? foldDebugMode(context.agent.session.events)) ? this.section : '';
      },
    });

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: DEBUG_COMMAND,
        description: 'Enter or leave debug mode',
        input: { hint: '[off]' },
        handler: ({ agent, rawInput }) => {
          const message = rawInput.trim();
          const active = message !== 'off';
          const outcome = this.set(agent, active);
          if (active) {
            return {
              kind: 'success',
              text:
                outcome === 'committed'
                  ? 'Debug mode on. Use /debug off to leave.'
                  : 'Entering debug mode (applies from the next step). Use /debug off to leave.',
            };
          }
          switch (outcome) {
            case 'committed':
              return { kind: 'success', text: 'Debug mode off.' };
            case 'queued':
              return { kind: 'success', text: 'Leaving debug mode (applies from the next step).' };
            case 'cancelled':
              return { kind: 'success', text: 'Debug mode entry cancelled.' };
            case 'noop':
              return foldDebugMode(agent.session.events)
                ? { kind: 'success', text: 'Leaving debug mode (applies from the next step).' }
                : { kind: 'success', text: 'Debug mode is already inactive.' };
          }
        },
      });
    });
  }

  /** Read the logged debug state and any pending selection. */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = foldDebugMode(agent.session.events);
    const pending = this.pendingIntents.get(agent.session);
    return pending === undefined ? { active } : { active, pending: pending.active };
  }

  /** Select whether debug mode should be active (same semantics as plan-mode `set`). */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session;
    const pending = this.pendingIntents.get(session);
    const target = pending?.active ?? foldDebugMode(session.events);
    if (active === target) return 'noop';
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, { active, narrate: true });
      return foldDebugMode(session.events) === active ? 'cancelled' : 'queued';
    }
    if (active === foldDebugMode(session.events)) {
      this.pendingIntents.delete(session);
      return 'cancelled';
    }
    session.append(DEBUG_MODE_EVENT, { active });
    this.pendingIntents.delete(session);
    const narration = this.narration(session, active);
    if (narration !== undefined) agent.inject(narration);
    return 'committed';
  }

  /** Append one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session);
    if (pending === undefined) return;
    const target = pending.active;
    if (target === foldDebugMode(session.events)) {
      this.pendingIntents.delete(session);
      return;
    }
    session.append(DEBUG_MODE_EVENT, { active: target });
    this.pendingIntents.delete(session);
  }

  /** Build a user-switch notice when the last logged header described the other mode. */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = debugModeAtLastHeader(session.events);
    if (told === undefined || told === target) return undefined;
    const text = target
      ? 'The user switched this session to debug mode.'
      : 'The user switched this session back to the default mode.';
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The narration is already one sentence, so it is its own summary.
      source: { kind: 'plugin', plugin: 'cardo-modes', form: 'notice', summary: text },
    });
  }
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false;
  for (const event of events) {
    if (event.type === 'turn/start') open = true;
    else if (event.type === 'turn/end') open = false;
  }
  return open;
}

/** Debug state at the last logged request header, or `undefined` before the first header. */
function debugModeAtLastHeader(events: readonly SessionEvent[]): boolean | undefined {
  let lastHeader = -1;
  let index = 0;
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index;
    index += 1;
  }
  if (lastHeader < 0) return undefined;
  return foldDebugMode(events, lastHeader + 1);
}

/**
 * Bundle entry point. The Cordis loader imports the package's default export
 * (class form, like `@deepseek-ai/dsh-plan-mode`): the loader owns the
 * Service lifecycle, waits for the declared `inject` services, and calls the
 * constructor with an injection-ready context.
 */
export default DebugModeController;
