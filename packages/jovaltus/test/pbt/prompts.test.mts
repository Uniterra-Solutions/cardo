/**
 * Integrated PBT — Jovaltus prompt rendering (`dist/prompts.js`).
 *
 * Business invariants encoded as properties:
 *  1. Bug #1 regression: every phase prompt must be loadable from the
 *     COMPILED output (dist/prompts/). tsc never copies the .md assets; the
 *     build script now does. A dist consumer (desktop app) that cannot load
 *     a prompt fails on the very first phase dispatch — this suite pins it.
 *  2. Every raw prompt carries the pipeline marker placeholder (so the
 *     child-subagent marker substitution is meaningful in every phase).
 *  3. renderPrompt over the whole dispatch space: no leftover [[token]]
 *     placeholders, exactly one correct [jovaltus-pipeline:TOOL:PHASE]
 *     marker, run_dir / repo_root / plan_path substituted, plan_step swapped
 *     for standalone-review instructions when there is no plan.
 *  4. Waiting phases and 'done' have no prompt — renderPrompt throws
 *     deterministically (they are never dispatched).
 *  5. buildContext carries the exact repo/run/phase/plan lines the child
 *     backend parses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { PROMPT_NAMES, buildContext, loadPrompt, renderPrompt } from '../../dist/prompts.js';
import type { PipelineState } from '../../dist/state.js';
import { CHAIN, WAITING_PHASES } from '../../dist/chain.js';

/** (tool, phase) pairs the dispatcher actually renders prompts for. */
const DISPATCH_PAIRS: Array<{ tool: string; phase: string }> = Object.entries(CHAIN)
  .flatMap(([tool, chain]) =>
    Object.keys(chain)
      .filter((phase) => !WAITING_PHASES.includes(phase))
      .map((phase) => ({ tool, phase })),
  )
  .filter((pair) => pair.phase !== 'done');

function makeState(overrides?: Partial<PipelineState>): PipelineState {
  return {
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
    ...overrides,
  };
}

test('bug#1 regression: every phase prompt loads from the compiled dist output', () => {
  for (const name of PROMPT_NAMES) {
    const prompt = loadPrompt(name);
    assert.ok(prompt.length > 0, `${name}.md loads and is non-empty`);
    assert.ok(
      prompt.includes('[jovaltus-pipeline:TOOL:PHASE]'),
      `${name}.md carries the marker placeholder`,
    );
  }
});

test('renderPrompt: no leftover tokens, exactly one correct marker, for the whole dispatch space', async () => {
  await fc.assert(
    fc.property(
      fc.constantFrom(...DISPATCH_PAIRS.map((p) => `${p.tool}/${p.phase}`)),
      fc.string({ maxLength: 64 }),
      fc.string({ maxLength: 48 }),
      fc.oneof(fc.constant(null), fc.string({ maxLength: 64 })),
      fc.string({ maxLength: 48 }),
      (pairKey, runDir, requirements, planPath, cwd) => {
        const [tool, phase] = pairKey.split('/');
        assert.ok(tool !== undefined && phase !== undefined);
        const p = makeState({
          run_dir: runDir,
          tool,
          phase,
          user_requirements: requirements,
          plan_path: planPath,
        });
        const rendered = renderPrompt(p, phase, cwd);
        // No KNOWN placeholder survives substitution (user data may
        // legitimately contain '[[', so only the exact tokens are checked).
        for (const token of [
          '[[run_dir]]',
          '[[repo_root]]',
          '[[user_requirements]]',
          '[[plan_step]]',
          '[[plan_path]]',
        ]) {
          assert.ok(!rendered.includes(token), `no leftover ${token} in ${tool}/${phase}`);
        }
        assert.ok(
          !rendered.includes('[jovaltus-pipeline:TOOL:PHASE]'),
          `marker placeholder substituted in ${tool}/${phase}`,
        );
        // Exactly one marker, and it names this exact tool/phase.
        const markers = rendered.split('[jovaltus-pipeline:').length - 1;
        assert.equal(markers, 1, `exactly one pipeline marker in ${tool}/${phase}`);
        assert.ok(
          rendered.includes(`[jovaltus-pipeline:${tool}:${phase}]`),
          `marker names ${tool}/${phase}`,
        );
        // Context substitution.
        assert.ok(rendered.includes(runDir), 'run_dir substituted');
        assert.ok(rendered.includes(cwd), 'repo_root substituted');
      },
    ),
  );
});

test('renderPrompt: plan_path and plan_step resolve to the plan or standalone review', () => {
  // With a plan: the plan-reading step names the plan path.
  const withPlan = renderPrompt(
    makeState({ tool: 'review', phase: 'review', plan_path: '/plans/tasks.md' }),
    'review',
    '/repo',
  );
  assert.ok(withPlan.includes('Read the plan at `/plans/tasks.md`'));
  assert.ok(withPlan.includes('/plans/tasks.md'));
  // Without a plan: standalone-review instructions, plan_path renders empty.
  const withoutPlan = renderPrompt(
    makeState({ tool: 'simplify', phase: 'simplify', plan_path: null }),
    'simplify',
    '/repo',
  );
  assert.ok(withoutPlan.includes('There is no plan for this run'));
  assert.ok(!withoutPlan.includes('[[plan_step]]'));
  assert.ok(!withoutPlan.includes('[[plan_path]]'));
});

test('renderPrompt regression: $-patterns in user fields render literally', () => {
  // String replacements would interpret $&, $`, $', $n and re-inject the
  // token text (bug fixed with function replacements); the rendered prompt
  // must carry the user's literal text and no surviving tokens.
  const rendered = renderPrompt(
    makeState({
      run_dir: 'run/$&',
      user_requirements: "cost $& and $` and $' and $1",
      plan_path: '$&',
    }),
    'prd',
    '/repo $`',
  );
  assert.ok(rendered.includes('run/$&'), 'run_dir value appears literally');
  assert.ok(rendered.includes("cost $& and $` and $' and $1"), 'requirements appear literally');
  assert.ok(rendered.includes('/repo $`'), 'cwd appears literally');
  // And no token survives anywhere in the rendered text.
  for (const token of [
    '[[run_dir]]',
    '[[repo_root]]',
    '[[user_requirements]]',
    '[[plan_step]]',
    '[[plan_path]]',
  ]) {
    assert.ok(!rendered.includes(token), `no surviving ${token}`);
  }
});

test('renderPrompt: waiting phases and done have no prompt and throw deterministically', () => {
  for (const phase of [...WAITING_PHASES, 'done']) {
    assert.throws(
      () => renderPrompt(makeState({ tool: 'simplify', phase }), phase, '/repo'),
      /no prompt for phase/,
      `${phase} has no phase prompt`,
    );
  }
});

test('buildContext: exact lines the child backend parses', async () => {
  await fc.assert(
    fc.property(fc.string({ maxLength: 48 }), fc.string({ maxLength: 64 }), (cwd, runDir) => {
      const ctx = buildContext(
        makeState({
          run_dir: runDir,
          tool: 'review',
          phase: 'review',
          plan_path: '/plans/tasks.md',
        }),
        cwd,
      );
      assert.ok(ctx.includes(`## Repo root\n${cwd}`));
      assert.ok(ctx.includes(`## Run directory\n${runDir}`));
      assert.ok(ctx.includes('## Pipeline phase\nreview'));
      assert.ok(ctx.includes('## Plan path\n/plans/tasks.md'));
      // Plan-less runs carry an empty plan path line.
      const noPlan = buildContext(
        makeState({ tool: 'simplify', phase: 'simplify', plan_path: null }),
        cwd,
      );
      assert.ok(noPlan.includes('## Plan path\n'));
    }),
  );
});
