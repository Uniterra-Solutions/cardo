/**
 * Integrated PBT — the `pi --mode json` stdout protocol decoder
 * (`dist/dispatch.js`).
 *
 * The extension's only view of the child backend is its JSONL stdout: it
 * must extract the final assistant text and stream deltas without ever
 * throwing on arbitrary output (a misbehaving or verbose backend must not
 * crash the pipeline). Invariants:
 *  1. extractFinalOutput returns the text of the LAST assistant message_end;
 *     earlier message_ends, user messages, and non-text content parts are
 *     ignored; no assistant message → ''.
 *  2. parseJsonlTail never throws on arbitrary line content (malformed JSON
 *     lines are dropped, not fatal).
 *  3. extractAssistantTextDelta is exactly extractFinalOutput (the delta
 *     stream and the final output agree).
 *  4. getPiInvocation resolves the child command per the embedded-host
 *     contract: PI_CLI_PATH .js/.mjs → current runtime; compiled binary →
 *     direct exec; nothing set → the 'pi' fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fc from 'fast-check';
import {
  extractAssistantTextDelta,
  extractFinalOutput,
  parseJsonlTail,
} from '../../dist/dispatch.js';
import { FAKE_PI_PATH } from '../helpers/stub-api.mts';

const arbContent = fc.array(
  fc.oneof(
    fc.record({ type: fc.constant('text'), text: fc.string({ maxLength: 20 }) }),
    fc.record({ type: fc.constant('thinking'), text: fc.string({ maxLength: 20 }) }),
    fc.record({ type: fc.constant('tool_use'), id: fc.string({ maxLength: 10 }) }),
  ),
  { maxLength: 3 },
);

const arbEvent = fc.oneof(
  fc.record({
    type: fc.constant('message_end'),
    message: fc.record({ role: fc.constant('assistant'), content: arbContent }),
  }),
  fc.record({
    type: fc.constant('message_end'),
    message: fc.record({ role: fc.constant('user'), content: arbContent }),
  }),
  fc.record({
    type: fc.constant('message_start'),
    message: fc.record({ role: fc.constant('assistant'), content: fc.constant([]) }),
  }),
  fc.record({ type: fc.constant('done') }),
  fc.record({ type: fc.constant('tool_call') }),
);

interface MessageEndEvent {
  type?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
}

/** Spec-model: the last assistant message_end THAT HAS TEXT, joined by \n.
 *  The decoder scans backwards and skips assistant message_ends whose text
 *  parts are empty (a trailing empty message_end does not hide an earlier
 *  populated one). Equivalent forward formulation: keep the text of every
 *  assistant message_end with text — the last one wins. */
function expectedFinal(events: unknown[]): string {
  let result = '';
  for (const raw of events) {
    if (raw !== null && typeof raw === 'object') {
      const evt = raw as MessageEndEvent;
      if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
        const texts = (evt.message.content ?? [])
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text ?? '');
        if (texts.length > 0) {
          result = texts.join('\n');
        }
      }
    }
  }
  return result;
}

test('extractFinalOutput: last assistant message_end wins; nothing → empty string', async () => {
  await fc.assert(
    fc.property(fc.array(arbEvent, { maxLength: 12 }), (events) => {
      const stdout = events.map((e) => JSON.stringify(e)).join('\n');
      assert.equal(extractFinalOutput(stdout), expectedFinal(events));
      assert.equal(extractAssistantTextDelta(stdout), expectedFinal(events));
    }),
  );
});

test('extractAssistantTextDelta: delta stream agrees with final output', async () => {
  await fc.assert(
    fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 20 }), (lines) => {
      const stdout = lines.join('\n');
      assert.equal(extractAssistantTextDelta(stdout), extractFinalOutput(stdout));
    }),
  );
});

test('parseJsonlTail: total over arbitrary lines, malformed lines dropped', async () => {
  await fc.assert(
    fc.property(fc.array(fc.string({ maxLength: 80 }), { maxLength: 40 }), (lines) => {
      const events = parseJsonlTail(lines.join('\n'));
      assert.ok(Array.isArray(events));
      // Well-formed JSON lines survive; garbage lines become {} entries at
      // most — never an exception.
      const parsedCount = lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          return false;
        }
        try {
          JSON.parse(trimmed);
          return true;
        } catch {
          return false;
        }
      }).length;
      assert.ok(events.length <= lines.length);
      assert.ok(events.length >= parsedCount, `at least the parseable lines survive`);
    }),
  );
});

test('extractFinalOutput: deterministic edge cases', () => {
  assert.equal(extractFinalOutput(''), '');
  assert.equal(extractFinalOutput('not json at all\n{{{'), '');
  assert.equal(
    extractFinalOutput('{"type":"message_end","message":{"role":"assistant","content":[]}}'),
    '',
  );
  assert.equal(
    extractFinalOutput(
      [
        '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"user says"}]}}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","text":"think"},{"type":"text","text":"second"}]}}',
      ].join('\n'),
    ),
    'second',
  );
});

test('getPiInvocation: embedded-host contract via child processes', () => {
  const packageDir = new URL('../..', import.meta.url).pathname;
  const run = (env: Record<string, string | undefined>): { command: string; args: string[] } => {
    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import("./dist/dispatch.js").then(m => console.log(JSON.stringify(m.getPiInvocation([]))))',
      ],
      { cwd: packageDir, env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `child exited 0: ${res.stderr ?? ''}`);
    const out = res.stdout?.trim() ?? '';
    return JSON.parse(out) as { command: string; args: string[] };
  };

  // A .mjs pi entry (e.g. the desktop's cli.js under Electron): run under the
  // current runtime with the entry as argv[1].
  const jsEntry = run({ PI_CLI_PATH: FAKE_PI_PATH });
  assert.equal(jsEntry.command, process.execPath);
  assert.deepEqual(jsEntry.args, [FAKE_PI_PATH]);

  // A compiled pi binary: executed directly.
  const compiled = run({ PI_CLI_PATH: '/usr/local/bin/pi' });
  assert.equal(compiled.command, '/usr/local/bin/pi');
  assert.deepEqual(compiled.args, []);

  // No PI_CLI_PATH and no script: fall back to the `pi` executable.
  const fallback = run({ PI_CLI_PATH: undefined });
  assert.equal(fallback.command, 'pi');
  assert.deepEqual(fallback.args, []);
});
