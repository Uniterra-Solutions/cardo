/**
 * Reasoning-preservation regression + property tests for the dual-protocol
 * translators. The business invariant: NO content the wire emits may be
 * silently dropped — every non-empty reasoning/text/tool-call fragment must
 * reach the harness, for every wire shape real OpenAI-compatible gateways use.
 *
 * Reasoning wire shapes covered (verified against the OpenAI API reference and
 * the openai-node / litellm type definitions):
 *  - Chat Completions: `delta.reasoning_content` (DeepSeek/Qwen/GLM style),
 *    `delta.reasoning` (OpenRouter/aggregator style), and the final-chunk
 *    `message.reasoning_content` full-text replay (DashScope compatible mode).
 *  - Responses API: `response.reasoning_text.delta`/`done`,
 *    `response.reasoning_summary_text.delta`/`done` (OpenAI o-series),
 *    `response.output_item.added`/`done` with a `reasoning` item
 *    (`content`/`summary` parts), `response.content_part.added`/`done` with
 *    `reasoning_text` parts, and the authoritative `response.output` array on
 *    `response.completed`.
 *
 * The seeded property tests generate arbitrary interleavings of those shapes
 * and assert the translated blocks equal exactly the wire content (no loss, no
 * duplication). The deterministic cases pin each concrete real-world shape.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  serializeChatRequest,
  serializeResponsesRequest,
  translateChat,
  translateResponses,
} from '../lib/index.js';

/** Deterministic 32-bit PRNG so failing counterexamples are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/** Concatenate every block-end text of one block type, in emission order. */
function blockTexts(chunks, type) {
  return chunks
    .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === type)
    .map((chunk) => chunk.block.text);
}

// ── Deterministic regression cases (one per wire shape) ────────────────────

test('chat: delta.reasoning (OpenRouter/aggregator style) is preserved', async () => {
  const chunks = await collect(
    translateChat(
      (async function* () {
        yield JSON.stringify({ choices: [{ delta: { reasoning: 'think ' } }] });
        yield JSON.stringify({ choices: [{ delta: { reasoning: 'hard' } }] });
        yield JSON.stringify({ choices: [{ delta: { content: 'answer' } }] });
        yield '[DONE]';
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['think hard']);
  assert.deepEqual(blockTexts(chunks, 'text'), ['answer']);
});

test('chat: final-chunk message.reasoning_content (DashScope style) is preserved', async () => {
  const chunks = await collect(
    translateChat(
      (async function* () {
        yield JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] });
        yield JSON.stringify({ choices: [{ delta: { content: 'the answer' } }] });
        yield JSON.stringify({
          choices: [
            { delta: {}, finish_reason: 'stop', message: { reasoning_content: 'full think' } },
          ],
        });
        yield '[DONE]';
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['full think']);
  assert.deepEqual(blockTexts(chunks, 'text'), ['the answer']);
});

test('responses: reasoning_summary_text.delta (OpenAI o-series style) is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_1', summary: [] },
        });
        yield JSON.stringify({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          delta: 'summar',
        });
        yield JSON.stringify({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          delta: 'ized',
        });
        yield JSON.stringify({
          type: 'response.output_text.delta',
          item_id: 'm1',
          output_index: 1,
          delta: 'answer',
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['summarized']);
  assert.deepEqual(blockTexts(chunks, 'text'), ['answer']);
});

test('responses: complete reasoning output item without deltas is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'partial' }],
          },
        });
        yield JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            content: [{ type: 'reasoning_text', text: 'deep think ' }],
            summary: [{ type: 'summary_text', text: 'summary here' }],
          },
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['deep think summary here']);
});

test('responses: content_part reasoning_text parts are preserved', async () => {
  // Real gateways send the complete part on `added` and repeat it on `done`;
  // the translator must keep the part without duplicating it…
  const streamed = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.content_part.added',
          item_id: 'rs_1',
          output_index: 0,
          part: { type: 'reasoning_text', text: 'part one' },
        });
        yield JSON.stringify({
          type: 'response.content_part.done',
          item_id: 'rs_1',
          output_index: 0,
          part: { type: 'reasoning_text', reasoning: 'part one' },
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(streamed, 'reasoning'), ['part one']);

  // …and a done-only part (no added event) still surfaces its full text.
  const doneOnly = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.content_part.done',
          item_id: 'rs_2',
          output_index: 0,
          part: { type: 'reasoning_text', reasoning: 'only done' },
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(doneOnly, 'reasoning'), ['only done']);
});

test('responses: reasoning_text.done with full text and no deltas is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.reasoning_text.done',
          item_id: 'rs_1',
          output_index: 0,
          text: 'whole think',
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['whole think']);
});

test('responses: reasoning carried only in response.completed output is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'r1',
            status: 'completed',
            output: [
              {
                type: 'reasoning',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'only at the end' }],
              },
              {
                type: 'message',
                id: 'm1',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'final answer' }],
              },
            ],
          },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['only at the end']);
  assert.deepEqual(blockTexts(chunks, 'text'), ['final answer']);
});

test('responses: streamed deltas are not duplicated by the done/completed replay', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.reasoning_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          delta: 'one ',
        });
        yield JSON.stringify({
          type: 'response.reasoning_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          delta: 'two',
        });
        yield JSON.stringify({
          type: 'response.reasoning_text.done',
          item_id: 'rs_1',
          output_index: 0,
          text: 'one two',
        });
        yield JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            content: [{ type: 'reasoning_text', text: 'one two' }],
            summary: [{ type: 'summary_text', text: 'dup' }],
          },
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'r1',
            status: 'completed',
            output: [
              {
                type: 'reasoning',
                id: 'rs_1',
                content: [{ type: 'reasoning_text', text: 'one two' }],
                summary: [{ type: 'summary_text', text: 'dup' }],
              },
            ],
          },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['one two']);
});

test('chat: final-chunk message.content replay (buffered gateway) is preserved', async () => {
  const chunks = await collect(
    translateChat(
      (async function* () {
        yield JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] });
        yield JSON.stringify({
          choices: [
            {
              delta: {},
              finish_reason: 'stop',
              message: { content: 'buffered answer' },
            },
          ],
        });
        yield '[DONE]';
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'text'), ['buffered answer']);
});

test('chat: final-chunk message.tool_calls replay (buffered gateway) is preserved', async () => {
  const chunks = await collect(
    translateChat(
      (async function* () {
        yield JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] });
        yield JSON.stringify({
          choices: [
            {
              delta: {},
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  { index: 0, id: 't9', function: { name: 'f1', arguments: '{"a":1}' } },
                ],
              },
            },
          ],
        });
        yield '[DONE]';
      })(),
    ),
  );
  const toolBlock = chunks.find(
    (chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call',
  );
  assert.equal(toolBlock.block.id, 't9');
  assert.equal(toolBlock.block.name, 'f1');
  assert.equal(toolBlock.block.arguments, '{"a":1}');
});

test('chat: streamed deltas are not duplicated by a final message replay', async () => {
  const chunks = await collect(
    translateChat(
      (async function* () {
        yield JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] });
        yield JSON.stringify({ choices: [{ delta: { content: 'streamed' } }] });
        yield JSON.stringify({
          choices: [
            {
              delta: {},
              finish_reason: 'stop',
              message: { reasoning_content: 'think', content: 'streamed' },
            },
          ],
        });
        yield '[DONE]';
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['think']);
  assert.deepEqual(blockTexts(chunks, 'text'), ['streamed']);
});

test('responses: reasoning_summary_part.done with full text and no deltas is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.reasoning_summary_part.done',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          part: { type: 'summary_text', text: 'part summary' },
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['part summary']);
});

test('responses: content_part.done output_text part with no deltas is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.content_part.done',
          item_id: 'm1',
          output_index: 0,
          part: { type: 'output_text', text: 'whole part' },
        });
        yield JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', status: 'completed', output: [] },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'text'), ['whole part']);
});

test('responses: incomplete response still materializes its buffered output', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            output: [
              {
                type: 'reasoning',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'half think' }],
              },
              {
                type: 'message',
                id: 'm1',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'half answer' }],
              },
            ],
          },
        });
      })(),
    ),
  );
  assert.deepEqual(blockTexts(chunks, 'reasoning'), ['half think']);
  assert.deepEqual(blockTexts(chunks, 'text'), ['half answer']);
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'error');
});

test('responses: buffered function_call arriving only in response.completed is preserved', async () => {
  const chunks = await collect(
    translateResponses(
      (async function* () {
        yield JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'r1',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'get_weather',
                arguments: '{"city":"x"}',
              },
            ],
          },
        });
      })(),
    ),
  );
  const toolBlock = chunks.find(
    (chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call',
  );
  assert.equal(toolBlock.block.name, 'get_weather');
  assert.equal(toolBlock.block.arguments, '{"city":"x"}');
});

// ── Agent-loop round-trip: history serialization ───────────────────────────
//
// The harness keeps reasoning blocks in the assistant history verbatim (see
// dsh-session's deriveEventMessage); the adapter must replay them on the wire
// so gateways that mandate it (DeepSeek chat tool-call turns) or benefit from
// it (Responses API conversation state) never see a truncated transcript.

test('agent-loop: Responses serialization round-trips assistant reasoning as a reasoning item', () => {
  const wire = serializeResponsesRequest({
    model: 'm1',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'solve' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think step 1' },
          { type: 'text', text: 'the answer' },
        ],
      },
    ],
  });
  assert.deepEqual(wire.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'solve' }] },
    {
      type: 'reasoning',
      id: 'reasoning_1',
      content: [{ type: 'reasoning_text', text: 'think step 1' }],
      summary: [{ type: 'summary_text', text: 'think step 1' }],
    },
    { role: 'assistant', content: [{ type: 'output_text', text: 'the answer' }] },
  ]);
});

test('agent-loop: Chat serialization replays reasoning_content on tool-call turns', () => {
  const wire = serializeChatRequest({
    model: 'm1',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    ],
  });
  const assistant = wire.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'think');
  assert.deepEqual(assistant.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
  ]);
});

test('agent-loop: Responses serialization replays reasoning on tool-call turns', () => {
  // DeepSeek's Responses API in thinking mode rejects a multi-turn tool-call
  // continuation with "The `reasoning_text` … must be passed back to the API"
  // unless the prior turn's chain-of-thought is replayed as a `reasoning`
  // input item BEFORE the function_call items. The adapter must not drop it.
  const wire = serializeResponsesRequest({
    model: 'm1',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'solve' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    ],
  });
  assert.deepEqual(wire.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'solve' }] },
    {
      type: 'reasoning',
      id: 'reasoning_1',
      content: [{ type: 'reasoning_text', text: 'think' }],
      summary: [{ type: 'summary_text', text: 'think' }],
    },
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ]);
});

test('property: Responses serialization never drops assistant reasoning', () => {
  const rand = mulberry32(0x5eed);
  const pick = (items) => items[Math.floor(rand() * items.length)];

  for (let run = 0; run < 300; run += 1) {
    const messages = [];
    const expectedReasoning = [];
    const turnCount = 1 + Math.floor(rand() * 6);
    for (let turn = 0; turn < turnCount; turn += 1) {
      const content = [];
      if (rand() < 0.7) {
        const text = pick(['r1', 'r2', 'r3', 'r4']);
        content.push({ type: 'reasoning', text });
        expectedReasoning.push(text);
      }
      if (rand() < 0.4) content.push({ type: 'text', text: pick(['a1', 'a2']) });
      const toolCall = rand() < 0.6;
      if (toolCall) content.push({ type: 'tool-call', id: `c${turn}`, name: 'f', arguments: '{}' });
      messages.push({ role: 'assistant', content });
      if (toolCall) {
        messages.push({
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: `c${turn}`, content: [{ type: 'text', text: 'ok' }] },
          ],
        });
      }
    }

    const wire = serializeResponsesRequest({ model: 'm1', messages });
    const wireReasoning = wire.input
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => item.content.map((part) => part.text));

    assert.deepEqual(
      wireReasoning,
      expectedReasoning,
      `run ${run}: assistant reasoning lost or duplicated across a tool-call turn`,
    );
  }
});

// ── Seeded randomized properties ───────────────────────────────────────────

test('property: chat translation never drops or duplicates wire content', async () => {
  const rand = mulberry32(0xca4d0);
  const pick = (items) => items[Math.floor(rand() * items.length)];

  for (let run = 0; run < 300; run += 1) {
    const expectedReasoning = [];
    const expectedText = [];
    const expectedArgs = new Map();
    const payloads = [];
    let sawDeltaReasoning = false;
    const messageReasoning = [];
    const chunkCount = 2 + Math.floor(rand() * 15);
    let toolId = undefined;

    for (let at = 0; at < chunkCount; at += 1) {
      const choices = [];
      const choiceCount = 1 + (rand() < 0.2 ? 1 : 0);
      for (let c = 0; c < choiceCount; c += 1) {
        const delta = {};
        if (rand() < 0.5) {
          const fragment = pick(['r1', 'r2', 'r3', 'r4']);
          delta.reasoning_content = fragment;
          expectedReasoning.push(fragment);
          sawDeltaReasoning = true;
        }
        if (rand() < 0.5) {
          const fragment = pick(['t1', 't2', 't3']);
          delta.reasoning = fragment;
          expectedReasoning.push(fragment);
          sawDeltaReasoning = true;
        }
        if (rand() < 0.5) {
          const fragment = pick(['c1', 'c2', 'c3', 'c4']);
          delta.content = fragment;
          expectedText.push(fragment);
        }
        if (rand() < 0.35) {
          if (toolId === undefined) toolId = pick(['call-a', 'call-b']);
          const fragment = pick(['{"a":', '"x"}', '{"b":', '1}']);
          delta.tool_calls = [
            {
              index: 0,
              ...(rand() < 0.5 ? { id: toolId } : {}),
              function: { arguments: fragment },
            },
          ];
          expectedArgs.set(toolId, (expectedArgs.get(toolId) ?? '') + fragment);
        }
        choices.push(Object.keys(delta).length > 0 ? { delta } : { delta: { role: 'assistant' } });
      }
      const chunk = { choices };
      if (at === chunkCount - 1) {
        chunk.choices[0].finish_reason = 'stop';
        if (!sawDeltaReasoning && rand() < 0.7) {
          const fragment = pick(['full1', 'full2', 'full3']);
          chunk.choices[0].message =
            rand() < 0.5 ? { reasoning_content: fragment } : { reasoning: fragment };
          messageReasoning.push(fragment);
        }
      }
      payloads.push(JSON.stringify(chunk));
    }
    if (!sawDeltaReasoning) expectedReasoning.push(...messageReasoning);
    payloads.push(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), '[DONE]');

    const chunks = await collect(
      translateChat(
        (async function* () {
          for (const payload of payloads) yield payload;
        })(),
      ),
    );

    assert.equal(
      blockTexts(chunks, 'reasoning').join(''),
      expectedReasoning.join(''),
      `run ${run}: reasoning lost or duplicated`,
    );
    assert.equal(
      blockTexts(chunks, 'text').join(''),
      expectedText.join(''),
      `run ${run}: text lost or duplicated`,
    );
    if (toolId !== undefined) {
      const toolBlock = chunks.find(
        (chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call',
      );
      assert.equal(
        toolBlock.block.arguments,
        expectedArgs.get(toolId),
        `run ${run}: tool arguments lost or duplicated`,
      );
    }
  }
});

test('property: responses translation never drops or duplicates wire content', async () => {
  const rand = mulberry32(0x4e5);
  const pick = (items) => items[Math.floor(rand() * items.length)];

  for (let run = 0; run < 300; run += 1) {
    const expectedReasoning = [];
    const expectedText = [];
    const streamedReasoning = new Set();
    const streamedText = new Set();
    const payloads = [];
    const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };
    const reasoningDoneItem = {
      type: 'reasoning',
      id: 'rs_1',
      content: [{ type: 'reasoning_text', text: 'deep ' }],
      summary: [{ type: 'summary_text', text: 'summ' }],
    };
    const reasoningDoneExpected = ['deep ', 'summ'];
    const messageDoneItem = {
      type: 'message',
      id: 'm1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'msg' }],
    };
    const messageDoneExpected = ['msg'];
    const eventCount = 3 + Math.floor(rand() * 20);

    for (let at = 0; at < eventCount; at += 1) {
      const kind = pick([
        'reasoning-delta',
        'summary-delta',
        'reasoning-done',
        'summary-done',
        'text-delta',
        'text-done',
        'content-part-added',
        'content-part-done',
        'reasoning-item-done',
        'completed',
      ]);
      switch (kind) {
        case 'reasoning-delta': {
          const delta = pick(['a', 'b', 'c']);
          expectedReasoning.push(delta);
          streamedReasoning.add('rs_1');
          payloads.push(
            JSON.stringify({
              type: 'response.reasoning_text.delta',
              item_id: 'rs_1',
              output_index: 0,
              delta,
            }),
          );
          break;
        }
        case 'summary-delta': {
          const delta = pick(['s1', 's2', 's3']);
          expectedReasoning.push(delta);
          streamedReasoning.add('rs_1');
          payloads.push(
            JSON.stringify({
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs_1',
              output_index: 0,
              summary_index: 0,
              delta,
            }),
          );
          break;
        }
        case 'reasoning-done': {
          payloads.push(
            JSON.stringify({
              type: 'response.reasoning_text.done',
              item_id: 'rs_1',
              output_index: 0,
              text: 'whole',
            }),
          );
          if (!streamedReasoning.has('rs_1')) {
            expectedReasoning.push('whole');
            streamedReasoning.add('rs_1');
          }
          break;
        }
        case 'summary-done': {
          payloads.push(
            JSON.stringify({
              type: 'response.reasoning_summary_text.done',
              item_id: 'rs_1',
              output_index: 0,
              summary_index: 0,
              text: 'sumdone',
            }),
          );
          if (!streamedReasoning.has('rs_1')) {
            expectedReasoning.push('sumdone');
            streamedReasoning.add('rs_1');
          }
          break;
        }
        case 'text-delta': {
          const delta = pick(['t1', 't2', 't3']);
          expectedText.push(delta);
          streamedText.add('m1');
          payloads.push(
            JSON.stringify({
              type: 'response.output_text.delta',
              item_id: 'm1',
              output_index: 1,
              delta,
            }),
          );
          break;
        }
        case 'text-done': {
          payloads.push(
            JSON.stringify({
              type: 'response.output_text.done',
              item_id: 'm1',
              output_index: 1,
              text: 'textdone',
            }),
          );
          if (!streamedText.has('m1')) {
            expectedText.push('textdone');
            streamedText.add('m1');
          }
          break;
        }
        case 'content-part-added': {
          const text = pick(['p1', 'p2']);
          expectedReasoning.push(text);
          streamedReasoning.add('rs_1');
          payloads.push(
            JSON.stringify({
              type: 'response.content_part.added',
              item_id: 'rs_1',
              output_index: 0,
              part: { type: 'reasoning_text', text },
            }),
          );
          break;
        }
        case 'content-part-done': {
          payloads.push(
            JSON.stringify({
              type: 'response.content_part.done',
              item_id: 'rs_1',
              output_index: 0,
              part: { type: 'reasoning_text', reasoning: 'partdone' },
            }),
          );
          if (!streamedReasoning.has('rs_1')) {
            expectedReasoning.push('partdone');
            streamedReasoning.add('rs_1');
          }
          break;
        }
        case 'reasoning-item-done': {
          payloads.push(
            JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item: reasoningDoneItem,
            }),
          );
          if (!streamedReasoning.has('rs_1')) {
            expectedReasoning.push(...reasoningDoneExpected);
            streamedReasoning.add('rs_1');
          }
          break;
        }
        case 'completed': {
          const output = [];
          if (rand() < 0.5) output.push(reasoningDoneItem);
          if (rand() < 0.5) output.push(messageDoneItem);
          payloads.push(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'r1', status: 'completed', output },
            }),
          );
          if (output.includes(reasoningDoneItem) && !streamedReasoning.has('rs_1')) {
            expectedReasoning.push(...reasoningDoneExpected);
            streamedReasoning.add('rs_1');
          }
          if (output.includes(messageDoneItem) && !streamedText.has('m1')) {
            expectedText.push(...messageDoneExpected);
            streamedText.add('m1');
          }
          break;
        }
      }
    }
    // A terminal event is required for a complete stream; append one.
    payloads.push(
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'r1', status: 'completed', output: [] },
      }),
    );

    const chunks = await collect(
      translateResponses(
        (async function* () {
          for (const payload of payloads) yield payload;
        })(),
      ),
    );

    assert.equal(
      blockTexts(chunks, 'reasoning').join(''),
      expectedReasoning.join(''),
      `run ${run}: reasoning lost or duplicated`,
    );
    assert.equal(
      blockTexts(chunks, 'text').join(''),
      expectedText.join(''),
      `run ${run}: text lost or duplicated`,
    );
  }
});
