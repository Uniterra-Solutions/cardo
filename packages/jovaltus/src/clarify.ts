/**
 * Jovaltus human-in-loop requirement clarification.
 *
 * The PRD subagent writes `questions.json` (the open questions that still
 * need user confirmation, each with concrete suggested options). After the
 * PRD phase, the pipeline asks them ONE at a time:
 *
 *   - interactive hosts with the wizard surface (`ctx.ui.askQuestions`) get a
 *     single paged dialog — suggested options + a free-text "Other" path,
 *     Next/Submit paging, and a total count;
 *   - other interactive hosts (terminal TUI) fall back to one `select` per
 *     question with an "Other (type your own answer)" option;
 *   - headless / unavailable UI skips clarification entirely.
 *
 * The answers are persisted as `clarify.md` (human-readable Q&A, consumed by
 * later phases via `readPlanContext`) and `clarify.json` (structured, for
 * tests and tooling). A resumed run that already has answers skips the
 * dialog.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PipelineState } from './state.js';
import { CLARIFY_FILENAME } from './plan-json.js';

export const QUESTIONS_FILENAME = 'questions.json';
export const CLARIFY_JSON_FILENAME = 'clarify.json';

/** One open question + its suggested options (agent-authored). */
export interface ClarifyQuestion {
  readonly question: string;
  readonly options: readonly string[];
}

export interface ClarifyAnswer {
  readonly question: string;
  readonly answer: string;
}

/** Option label appended by the legacy (TUI) fallback for free-text input. */
export const OTHER_OPTION_LABEL = 'Other (type your own answer)';

function fileExists(p: string): boolean {
  try {
    return readFileSync(p, 'utf8').length >= 0;
  } catch {
    return false;
  }
}

/**
 * Read + validate the agent-authored `questions.json` from a run dir.
 * Malformed entries are dropped; returns [] when absent or invalid.
 */
export function readClarifyQuestions(runDir: string): readonly ClarifyQuestion[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path.join(runDir, QUESTIONS_FILENAME), 'utf8'));
  } catch {
    return [];
  }
  const raw = (data as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: ClarifyQuestion[] = [];
  for (const entry of raw) {
    const item = entry as { question?: unknown; options?: unknown };
    if (typeof item.question !== 'string' || item.question.trim().length === 0) {
      continue;
    }
    if (!Array.isArray(item.options)) {
      continue;
    }
    const options = item.options.filter(
      (opt): opt is string => typeof opt === 'string' && opt.trim().length > 0,
    );
    if (options.length === 0) {
      continue;
    }
    questions.push({ question: item.question.trim(), options });
  }
  return questions;
}

function alreadyAnswered(p: PipelineState): boolean {
  return (
    fileExists(path.join(p.run_dir, CLARIFY_FILENAME)) ||
    fileExists(path.join(p.run_dir, CLARIFY_JSON_FILENAME))
  );
}

function writeAnswers(
  runDir: string,
  questions: readonly ClarifyQuestion[],
  answers: readonly string[],
): void {
  const pairs: ClarifyAnswer[] = questions.map((q, i) => ({
    question: q.question,
    answer: answers[i] ?? '',
  }));
  const markdown = pairs.map((pair) => `### Q: ${pair.question}\n\n${pair.answer}\n`).join('\n');
  writeFileSync(path.join(runDir, CLARIFY_FILENAME), markdown, 'utf8');
  writeFileSync(
    path.join(runDir, CLARIFY_JSON_FILENAME),
    `${JSON.stringify({ questions: pairs }, null, 2)}\n`,
    'utf8',
  );
}

/** Legacy fallback for hosts without the wizard: one select per question. */
async function askLegacy(
  ctx: ExtensionContext,
  questions: readonly ClarifyQuestion[],
): Promise<readonly string[] | undefined> {
  if (typeof ctx.ui.select !== 'function' || typeof ctx.ui.input !== 'function') {
    return undefined;
  }
  const answers: string[] = [];
  for (const question of questions) {
    const options = [...question.options, OTHER_OPTION_LABEL];
    const choice = await ctx.ui.select(question.question, options);
    if (choice === undefined) {
      return undefined;
    }
    if (choice === OTHER_OPTION_LABEL) {
      const custom = await ctx.ui.input(question.question, 'Type your own answer');
      if (custom === undefined) {
        return undefined;
      }
      answers.push(custom.trim());
    } else {
      answers.push(choice);
    }
  }
  return answers;
}

/**
 * Human-in-loop requirement clarification, once per run (right after the
 * PRD). Reads the agent-authored open questions and asks them one at a time;
 * the answers are stored as `clarify.md` + `clarify.json` and become part of
 * the context injected into later phases. Skipped when headless, when the UI
 * is unavailable, when there are no open questions, or when already answered
 * (a resumed run).
 */
export async function clarifyRequirements(p: PipelineState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }
  const questions = readClarifyQuestions(p.run_dir);
  if (questions.length === 0 || alreadyAnswered(p)) {
    return;
  }
  try {
    let answers: readonly string[] | undefined;
    if (typeof ctx.ui.askQuestions === 'function') {
      answers = await ctx.ui.askQuestions('Jovaltus 需求釐清', questions);
    } else if (typeof ctx.ui.select === 'function' && typeof ctx.ui.input === 'function') {
      answers = await askLegacy(ctx, questions);
    } else {
      return;
    }
    if (answers === undefined) {
      // Dialog dismissed — treat as "requirements are clear".
      return;
    }
    writeAnswers(p.run_dir, questions, answers);
  } catch {
    // Dialog dismissed or unavailable — treat as "requirements are clear".
  }
}
