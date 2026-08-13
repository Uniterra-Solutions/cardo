/**
 * Jovaltus subagent prompt library (pi-agent port).
 *
 * Each prompt is a self-contained Markdown goal document for one pipeline
 * phase subagent. Dispatchers load a prompt with `loadPrompt` and substitute
 * `[[token]]` placeholders via `String.replace` — never template literals,
 * because prompt bodies contain mermaid `{}` braces.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineState } from './state.js';

export const PROMPT_NAMES: readonly string[] = [
  'prd',
  'research',
  'acceptance',
  'tasks',
  'execute',
  'simplify-review',
  'review',
] as const;

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

/** Return the raw Markdown prompt body for `name`, tokens intact. */
export function loadPrompt(name: string): string {
  if (!PROMPT_NAMES.includes(name)) {
    throw new Error(`unknown prompt: ${name}`);
  }
  return readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
}

/** Prompt name per pipeline phase. */
const PHASE_PROMPTS: Record<string, string> = {
  prd: 'prd',
  research: 'research',
  acceptance: 'acceptance',
  tasks: 'tasks',
  execute: 'execute',
  simplify: 'simplify-review',
  review: 'review',
};

/** Literal placeholder every prompt carries; substituted with the real marker. */
const MARKER_PLACEHOLDER = '[jovaltus-pipeline:TOOL:PHASE]';

function repoRoot(cwd: string): string {
  return cwd;
}

/**
 * The prompt's step-1 text: read the plan, or review standalone.
 */
function planStepText(p: PipelineState, phase: string): string {
  if (p.plan_path) {
    if (phase === 'review') {
      return (
        'Read the plan at `[[plan_path]]` to understand the intended ' +
        'behavior, requirements, and acceptance criteria.'
      );
    }
    return (
      'Read the plan at `[[plan_path]]` to understand the intended ' +
      'behavior and task boundaries.'
    );
  }
  return (
    'There is no plan for this run — review the uncommitted changes in ' +
    'the working tree (git status / git diff) on their own merits.'
  );
}

/**
 * Load the phase prompt and substitute tokens + the pipeline marker.
 */
export function renderPrompt(p: PipelineState, phase: string, cwd: string): string {
  const promptName = PHASE_PROMPTS[phase];
  if (promptName === undefined) {
    throw new Error(`no prompt for phase ${phase}`);
  }
  let text = loadPrompt(promptName);
  text = text.replaceAll('[[run_dir]]', p.run_dir);
  text = text.replaceAll('[[repo_root]]', repoRoot(cwd));
  text = text.replaceAll('[[user_requirements]]', p.user_requirements);
  // Plan-less simplify/review runs: replace the plan-reading step with a
  // standalone-review instruction. Done BEFORE [[plan_path]] substitution so
  // the step's own plan reference (which embeds [[plan_path]]) resolves too.
  text = text.replaceAll('[[plan_step]]', planStepText(p, phase));
  text = text.replaceAll('[[plan_path]]', p.plan_path ?? '');
  text = text.replaceAll(MARKER_PLACEHOLDER, `[jovaltus-pipeline:${p.tool}:${phase}]`);
  return text;
}

/** Context text for the child: repo root + run dir + phase info. */
export function buildContext(p: PipelineState, cwd: string): string {
  return (
    `## Repo root\n${repoRoot(cwd)}\n` +
    `## Run directory\n${p.run_dir}\n` +
    `## Pipeline phase\n${p.phase}\n` +
    `## Plan path\n${p.plan_path ?? ''}\n`
  );
}
