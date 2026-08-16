import { test } from 'node:test';
import assert from 'node:assert/strict';
import generalExtension from '../dist/index.js';

function loadHandler() {
  const handlers = new Map();
  generalExtension({ on: (event, handler) => handlers.set(event, handler) });
  return handlers.get('before_agent_start');
}

function run(basePrompt) {
  return loadHandler()({
    type: 'before_agent_start',
    prompt: 'hello',
    images: [],
    systemPrompt: basePrompt,
    systemPromptOptions: {},
  });
}

test('registers a before_agent_start handler', () => {
  const handlers = new Map();
  generalExtension({ on: (event, handler) => handlers.set(event, handler) });
  assert.ok(handlers.has('before_agent_start'));
});

test('appends the working rules to the base system prompt', () => {
  const base = 'You are an expert coding assistant operating inside pi.';
  const { systemPrompt } = run(base);
  assert.ok(systemPrompt.startsWith(base));
  assert.ok(systemPrompt.includes('Never use emoji in replies.'));
  assert.ok(systemPrompt.includes('write tests for each piece of business logic'));
  assert.ok(systemPrompt.includes("Reply in the user's language by default"));
});

test('does not accumulate duplicate rules across turns', () => {
  const handler = loadHandler();
  const base = 'base prompt';
  const once = handler({
    type: 'before_agent_start',
    prompt: '',
    systemPrompt: base,
    systemPromptOptions: {},
  }).systemPrompt;
  const twice = handler({
    type: 'before_agent_start',
    prompt: '',
    systemPrompt: base,
    systemPromptOptions: {},
  }).systemPrompt;
  assert.equal(once, twice);
  assert.equal(once.split('Never use emoji in replies.').length - 1, 1);
});
