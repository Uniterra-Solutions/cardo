/**
 * Copy bundled skill assets into the compiled output directory.
 *
 * `tsc -b` compiles TS sources but never copies non-code assets: the built-in
 * skills in `src/skills/*` are resolved at runtime RELATIVE to the compiled
 * module (`builtinSkillsDir()` -> `dist/skills`). Without this copy, any
 * consumer that loads `@cardo/skills` from `dist` (the desktop app via the
 * provisioning call, or the test suite) fails with ENOENT on the very first
 * `provisionBuiltinSkills()` call.
 *
 * Usage: node scripts/copy-skills.mjs [targetDir]
 *   - default target: dist/skills (used by `pnpm run build`)
 *   - explicit target: used by the test harness to mirror skills beside the
 *     compiled test fixtures
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcSkills = path.join(here, '..', 'src', 'skills');
const target = process.argv[2] ?? path.join(here, '..', 'dist', 'skills');

mkdirSync(target, { recursive: true });
let copied = 0;
for (const entry of readdirSync(srcSkills)) {
  const srcDir = path.join(srcSkills, entry);
  if (!statSync(srcDir).isDirectory() || !existsSync(path.join(srcDir, 'SKILL.md'))) {
    continue;
  }
  const destDir = path.join(target, entry);
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  cpSync(srcDir, destDir, { recursive: true });
  copied += 1;
}
if (copied === 0) {
  throw new Error(`copy-skills: no skill directories found under ${srcSkills}`);
}
console.log(`copy-skills: copied ${copied} skill(s) to ${target}`);
