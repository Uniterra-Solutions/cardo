/**
 * Provisioning tests for the @cardo/skills built-in registry (dist output).
 *
 * Invariants:
 *  1. The bundled skills directory ships every declared skill with a SKILL.md
 *     (metadata consistency between the manifest and on-disk assets).
 *  2. Every bundled skill has a non-empty description parsed from frontmatter.
 *  3. provisioning is idempotent: the second run skips everything already
 *     installed, and existing skill directories are never clobbered.
 *  4. `force` replaces an existing destination.
 *  5. `resolveAgentDir` mirrors pi's own resolution (env override wins).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  builtinSkillNames,
  builtinSkillsDir,
  listBuiltinSkills,
  provisionBuiltinSkills,
  resolveAgentDir,
} from '../dist/index.js';

function makeTmpAgentDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cardo-skills-test-'));
}

function cleanUp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('bundled skills dir ships every declared skill with a SKILL.md', () => {
  const root = builtinSkillsDir();
  assert.ok(existsSync(root), `bundled skills dir exists: ${root}`);
  for (const name of builtinSkillNames) {
    const skillDir = path.join(root, name);
    assert.ok(existsSync(skillDir), `skill dir exists: ${name}`);
    assert.ok(existsSync(path.join(skillDir, 'SKILL.md')), `SKILL.md exists: ${name}`);
  }
});

test('every bundled skill has a non-empty description from frontmatter', () => {
  const infos = listBuiltinSkills();
  assert.equal(infos.length, builtinSkillNames.length);
  for (const info of infos) {
    assert.ok(info.description.length > 0, `description parsed for ${info.name}`);
    assert.ok(existsSync(path.join(info.dir, 'SKILL.md')), `dir resolves for ${info.name}`);
  }
});

test('provisioning copies every skill into <agentDir>/skills and is idempotent', async () => {
  const agentDir = makeTmpAgentDir();
  try {
    const first = await provisionBuiltinSkills(agentDir);
    assert.deepEqual([...first.failed], []);
    assert.deepEqual([...first.installed].sort(), [...builtinSkillNames].sort());
    assert.deepEqual([...first.skipped], []);
    for (const name of builtinSkillNames) {
      assert.ok(existsSync(path.join(agentDir, 'skills', name, 'SKILL.md')), `installed: ${name}`);
    }

    const second = await provisionBuiltinSkills(agentDir);
    assert.deepEqual([...second.installed], []);
    assert.deepEqual([...second.skipped].sort(), [...builtinSkillNames].sort());
  } finally {
    cleanUp(agentDir);
  }
});

test('existing skill directories are preserved (user edits survive restarts)', async () => {
  const agentDir = makeTmpAgentDir();
  try {
    await provisionBuiltinSkills(agentDir);
    const target = path.join(agentDir, 'skills', 'qa', 'SKILL.md');
    const userNote = '# user-edited\n';
    writeFileSync(target, userNote);

    const again = await provisionBuiltinSkills(agentDir);
    assert.ok(again.skipped.includes('qa'), 'qa skipped on second run');
    assert.equal(readFileSync(target, 'utf-8'), userNote, 'user edit untouched');
  } finally {
    cleanUp(agentDir);
  }
});

test('force replaces an existing destination', async () => {
  const agentDir = makeTmpAgentDir();
  try {
    await provisionBuiltinSkills(agentDir);
    const target = path.join(agentDir, 'skills', 'qa', 'SKILL.md');
    writeFileSync(target, '# user-edited\n');

    const forced = await provisionBuiltinSkills(agentDir, { force: true });
    assert.ok(forced.installed.includes('qa'), 'qa reinstalled under force');
    const reinstalled = readFileSync(target, 'utf-8');
    assert.ok(reinstalled.includes('PRD-driven acceptance testing'), 'bundled content restored');
  } finally {
    cleanUp(agentDir);
  }
});

test('resolveAgentDir honors PI_CODING_AGENT_DIR and falls back to ~/.pi/agent', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = '~/custom-pi-agent';
    assert.equal(resolveAgentDir(), path.join(process.env.HOME ?? '', 'custom-pi-agent'));
    process.env.PI_CODING_AGENT_DIR = '/abs/path/agent';
    assert.equal(resolveAgentDir(), '/abs/path/agent');
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
  assert.equal(resolveAgentDir(), path.join(process.env.HOME ?? '', '.pi', 'agent'));
});
