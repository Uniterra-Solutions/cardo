/**
 * Copy Jovaltus prompt assets into the compiled output directory.
 *
 * `tsc -b` compiles TS sources but never copies non-code assets: the phase
 * prompts in `src/prompts/*.md` are resolved at runtime RELATIVE to the
 * compiled module (`path.join(path.dirname(import.meta.url), 'prompts')`).
 * Without this copy, any consumer that loads `@cardo/jovaltus` from `dist`
 * (the desktop app via `packages/runtime`, or the PBT suite) fails on the
 * very first `loadPrompt` with ENOENT.
 *
 * Usage: node scripts/copy-prompts.mjs [targetDir]
 *   - default target: dist/prompts (used by `pnpm run build`)
 *   - explicit target: used by the PBT harness to mirror prompts beside the
 *     compiled test fixtures
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPrompts = path.join(here, '..', 'src', 'prompts');
const target = process.argv[2] ?? path.join(here, '..', 'dist', 'prompts');

mkdirSync(target, { recursive: true });
let copied = 0;
for (const entry of readdirSync(srcPrompts)) {
  const srcFile = path.join(srcPrompts, entry);
  if (!statSync(srcFile).isFile()) {
    continue;
  }
  copyFileSync(srcFile, path.join(target, entry));
  copied += 1;
}
if (copied === 0) {
  throw new Error(`copy-prompts: no prompt files found under ${srcPrompts}`);
}
console.log(`copy-prompts: copied ${copied} prompt(s) to ${target}`);
