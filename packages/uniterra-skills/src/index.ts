/**
 * Uniterra built-in skill registry — bundles the company-standard skills and
 * provisions them into the uniterra desktop app's dsh skills directory.
 *
 * The desktop shell (packages/uniterra-desktop) sets DSH_BUNDLED_SKILL_DIR to
 * this package's `src/skills` (dev) or a bundled copy (packaged); dsh's
 * rank-600 bundled skill provider discovers them like any other skill.
 * `provisionBuiltinSkills()` additionally copies them into a target skills
 * directory; skills that already exist there are left untouched so user
 * edits are never clobbered.
 *
 * The bundled content lives in `src/skills/*` and is copied to
 * `dist/skills/` by `scripts/copy-skills.mjs` during the build — consumers
 * must load this package from its built `dist` output.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAMES = [
  'uniterra-pbt-debugging',
  'uniterra-plan',
  'uniterra-implement',
  'uniterra-simplify',
  'uniterra-review',
  'manage-agents-md',
  'manage-git-repo',
  'project-documentation',
  'uniterra-qa',
  'create-skill',
] as const;

export type BuiltinSkillName = (typeof SKILL_NAMES)[number];

/** Skills retired from the uniterra bundle (renamed, split, or folded into
 * other skills). Their previously-provisioned copies are removed from the
 * target skills dir — the copy loop never touches existing dirs, so without
 * this a retired skill would keep loading alongside its replacements
 * forever. Covers the pre-rename `cardo-*` names: the project rename ships
 * the same skills under `uniterra-*`, and old profiles must not keep loading
 * both. */
const RETIRED_SKILL_NAMES = [
  'qa',
  'cardo-planmode',
  'cardo-plan',
  'cardo-implement',
  'cardo-simplify',
  'cardo-review',
  'cardo-pbt-debugging',
  'cardo-qa',
] as const;

/** Names of every skill bundled with this package, in provision order. */
export const builtinSkillNames: readonly BuiltinSkillName[] = SKILL_NAMES;

export interface BuiltinSkillInfo {
  readonly name: BuiltinSkillName;
  readonly description: string;
  /** Absolute path to the bundled skill directory (`dist/skills/<name>`). */
  readonly dir: string;
}

export interface ProvisionFailure {
  readonly name: BuiltinSkillName;
  readonly message: string;
}

export interface ProvisionResult {
  readonly installed: readonly BuiltinSkillName[];
  readonly skipped: readonly BuiltinSkillName[];
  readonly failed: readonly ProvisionFailure[];
}

/** Absolute path to the bundled skill directories shipped with this package. */
export function builtinSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
}

/**
 * Resolve pi's agent config directory, mirroring pi's own `getAgentDir()`
 * without importing the ESM-only pi package from the CJS Electron main bundle:
 * `PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`.
 */
export function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~') ? path.join(homedir(), envDir.slice(1)) : path.resolve(envDir);
  }
  return path.join(homedir(), '.pi', 'agent');
}

/** List every bundled skill with the description parsed from its SKILL.md frontmatter. */
export function listBuiltinSkills(): BuiltinSkillInfo[] {
  const root = builtinSkillsDir();
  return SKILL_NAMES.map((name) => {
    const dir = path.join(root, name);
    return {
      name,
      description: readFrontmatterDescription(path.join(dir, 'SKILL.md')),
      dir,
    };
  });
}

/**
 * Provision the bundled skills into `<agentDir>/skills/`.
 *
 * Idempotent: a skill whose destination directory already exists is skipped
 * (unless `force` is set) so user edits survive restarts. Retired skills
 * (see RETIRED_SKILL_NAMES) are removed on every run — they are uniterra's own
 * replaced artifacts, not user skills. Returns a report of what was
 * installed, skipped, and failed — failures never throw.
 */
export function provisionBuiltinSkills(
  agentDir: string,
  options: { readonly force?: boolean } = {},
): ProvisionResult {
  const sourceRoot = builtinSkillsDir();
  const targetRoot = path.join(agentDir, 'skills');
  const installed: BuiltinSkillName[] = [];
  const skipped: BuiltinSkillName[] = [];
  const failed: ProvisionFailure[] = [];

  // Best-effort removal of retired skills (missing dirs are a no-op).
  for (const name of RETIRED_SKILL_NAMES) {
    try {
      rmSync(path.join(targetRoot, name), { recursive: true, force: true });
    } catch {
      // a locked dir must not fail provisioning
    }
  }

  for (const name of SKILL_NAMES) {
    const sourceDir = path.join(sourceRoot, name);
    if (!existsSync(path.join(sourceDir, 'SKILL.md'))) {
      failed.push({ name, message: `bundled skill missing: ${sourceDir}` });
      continue;
    }

    const targetDir = path.join(targetRoot, name);
    try {
      if (!options.force && existsSync(targetDir)) {
        skipped.push(name);
        continue;
      }
      mkdirSync(targetRoot, { recursive: true });
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      cpSync(sourceDir, targetDir, { recursive: true });
      installed.push(name);
    } catch {
      failed.push({ name, message: `failed to copy ${sourceDir} -> ${targetDir}` });
    }
  }

  return { installed, skipped, failed };
}

/** Parse the folded `description:` frontmatter field of a SKILL.md ("" if absent). */
function readFrontmatterDescription(filePath: string): string {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match || match[1] === undefined) {
    return '';
  }
  const lines = match[1].split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => line.trim().startsWith('description:'));
  if (keyIndex === -1) {
    return '';
  }
  const folded: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (line.trim() === '' && folded.length === 0) {
      continue;
    }
    if (!/^\s/.test(line)) {
      break;
    }
    folded.push(line.trim());
  }
  return folded.join(' ');
}
