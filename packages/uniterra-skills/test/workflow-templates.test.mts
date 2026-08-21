/**
 * Workflow-template contract tests for the bundled pipeline skills
 * (uniterra-plan / uniterra-implement / uniterra-review / uniterra-simplify).
 *
 * These lock the embedded workflow templates to the format the dsh `workflow`
 * tool actually accepts, so a template drift fails CI before it fails a run:
 *
 *  1. Every embedded ```js fence parses under dsh's exact compile wrapper
 *     `(async () => { <body> })()` — the same check the engine's
 *     `assertBodyParses` performs; a body that stops parsing fails every run
 *     with `SCRIPT_PARSE`.
 *  2. No fence body opens with `export const meta` — dsh rejects that with a
 *     pointed `SCRIPT_PARSE` error (meta is a separate tool parameter, never
 *     script text).
 *  3. Every file that embeds a workflow script instructs the REQUIRED `meta`
 *     tool parameter (`meta: { name, description }`) — omitting it fails the
 *     tool call before the script ever runs, and dsh rejects any meta field
 *     beyond name/description/whenToUse/phases with `META_INVALID`.
 *  4. The self-contained single-script templates (review / simplify / plan)
 *     execute to a terminal JSON result under stubbed hooks, proving the hook
 *     names, the `agent()` options (label/schema), the schema shapes, and the
 *     terminal `return` all match the engine contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { builtinSkillsDir } from '../dist/index.js';

const WORKFLOW_SKILLS = [
  'uniterra-plan',
  'uniterra-implement',
  'uniterra-review',
  'uniterra-simplify',
];

const DSH_WRAPPER_PREFIX = '(async () => {\n';
const DSH_WRAPPER_SUFFIX = '\n})()';

/** dsh's pointed rejection: a body opening with `export const meta`. */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/;

/** Files whose whole ```js fence is the runnable workflow script (with its args fixture). */
const RUNNABLE_TEMPLATES: ReadonlyArray<{ file: string; args: unknown }> = [
  {
    file: 'uniterra-review/assets/workflow-template.md',
    args: { goal: 'test goal', context: { requirements: '', design: '', acceptance: '' }, task: 'test task' },
  },
  {
    file: 'uniterra-simplify/assets/workflow-template.md',
    args: { goal: 'test goal', context: { requirements: '', design: '', acceptance: '' } },
  },
  {
    file: 'uniterra-plan/scripts/review-workflow.md',
    args: { prd_dir: '/tmp/prd', design_dir: '/tmp/design', acceptance_dir: '/tmp/acceptance' },
  },
];

function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every ```js fence body (the templates embed their scripts as ```js blocks). */
function jsFences(content: string): string[] {
  const fences: string[] = [];
  const re = /```js\n([\s\S]*?)```/g;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    fences.push(m[1]!);
  }
  return fences;
}

/** Build a minimal value satisfying a template schema (for stubbed agent results). */
function fillSchema(schema: unknown): unknown {
  const node = schema as {
    type?: string;
    required?: string[];
    properties?: Record<string, unknown>;
    items?: unknown;
  };
  switch (node.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of node.required ?? []) {
        out[key] = fillSchema(node.properties?.[key]);
      }
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return {};
  }
}

test('every workflow template script parses under dsh\'s wrapper and instructs the meta parameter', () => {
  const root = builtinSkillsDir();
  const files = WORKFLOW_SKILLS.flatMap((skill) => collectMarkdownFiles(path.join(root, skill)));
  const embedding = files.filter((file) => jsFences(readFileSync(file, 'utf8')).length > 0);
  assert.ok(embedding.length >= 6, `found the workflow template files (got ${embedding.length})`);

  for (const file of embedding) {
    const content = readFileSync(file, 'utf8');
    const relative = path.relative(root, file);
    const fences = jsFences(content);

    // Invariant 3: the required `meta` tool parameter is instructed.
    assert.match(
      content,
      /`meta:/,
      `${relative}: must instruct the required \`meta\` tool parameter (name + description)`,
    );

    for (let i = 0; i < fences.length; i++) {
      const body = fences[i]!;
      // Invariant 2: no `export const meta` inside the script body.
      assert.ok(
        !META_STATEMENT.test(body),
        `${relative} fence ${i}: body must not open with \`export const meta\``,
      );
      // Invariant 1: the body compiles under dsh's wrapper.
      assert.doesNotThrow(
        () =>
          new vm.Script(DSH_WRAPPER_PREFIX + body + DSH_WRAPPER_SUFFIX, {
            filename: `${relative}#fence${i}`,
          }),
        `${relative} fence ${i}: must parse under dsh's (async () => { body })() wrapper`,
      );
    }
  }
});

test('single-script templates execute to a terminal JSON result with stubbed hooks', async () => {
  const root = builtinSkillsDir();
  const hooks: Record<string, unknown> = {
    agent: async (prompt: string, opts?: { schema?: unknown }): Promise<unknown> => {
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.length > 0, 'agent() requires a non-empty prompt');
      return opts?.schema === undefined ? '' : fillSchema(opts.schema);
    },
    parallel: async (
      thunks: ReadonlyArray<() => Promise<unknown>>,
    ): Promise<Array<unknown | null>> =>
      Promise.all(
        thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)),
      ),
    pipeline: async (
      items: unknown[],
      ...stages: Array<(value: unknown, item: unknown, index: number) => unknown>
    ): Promise<Array<unknown | null>> =>
      Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          try {
            for (const stage of stages) {
              value = await stage(value, item, index);
            }
            return value;
          } catch {
            return null;
          }
        }),
      ),
    phase: (_title: string): void => undefined,
    log: (_message: string): void => undefined,
  };

  for (const { file, args } of RUNNABLE_TEMPLATES) {
    const absolute = path.join(root, file);
    const body = jsFences(readFileSync(absolute, 'utf8'))[0]!;
    const context: Record<string, unknown> = { ...hooks, args };
    vm.createContext(context);
    const script = new vm.Script(DSH_WRAPPER_PREFIX + body + DSH_WRAPPER_SUFFIX, {
      filename: file,
    });
    const result: unknown = await script.runInContext(context);
    assert.ok(result !== null && typeof result === 'object', `${file}: script must return a JSON object`);
    assert.doesNotThrow(
      () => JSON.stringify(result),
      `${file}: script result must be JSON-serializable`,
    );
  }
});
