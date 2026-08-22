/**
 * Bundle the host half into lib/index.js (ESM). Everything the runtime needs
 * is inlined so the plugin is self-contained — the profile copies it into
 * node_modules like a vendored plugin with no pnpm install step. The peer
 * faces the dsh host already provides are left external.
 * Types come from tsc (emitDeclarationOnly); this script owns the JavaScript
 * and rewrites the declaration emit's `.ts` specifiers (see below).
 */
import { build } from 'esbuild';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  sourcemap: true,
  // Peer faces provided by the dsh host (+ React, only used by the client
  // bundle, kept out of the host file too).
  external: ['@deepseek-ai/*', 'cordis', 'schemastery', 'react', 'react/jsx-runtime'],
});

console.log('uniterra-settings-ui: wrote lib/index.js');

// The sources import siblings with explicit `.ts` extensions
// (allowImportingTsExtensions); rewrite relative `.ts` specifiers in the
// declaration emit to `.js` so consumers resolve `./x.js` to `./x.d.ts`.
const TYPES_DIR = 'lib/types';
const SPECIFIER = /((?:from|import)\s*\(?\s*)'(\.{1,2}\/[^']+?)\.ts'/g;
for (const name of await readdir(TYPES_DIR)) {
  if (!name.endsWith('.d.ts')) continue;
  const file = join(TYPES_DIR, name);
  const source = await readFile(file, 'utf8');
  const rewritten = source.replace(SPECIFIER, "$1'$2.js'");
  if (rewritten !== source) {
    await writeFile(file, rewritten);
    console.log(`uniterra-settings-ui: rewrote .ts specifiers in ${file}`);
  }
}
