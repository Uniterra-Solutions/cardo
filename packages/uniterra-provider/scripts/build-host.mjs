/**
 * Bundle the host half into lib/index.js (ESM). Everything the runtime needs
 * to execute the adapter is inlined so the plugin is self-contained: the
 * profile copies it into node_modules like a vendored plugin, with no pnpm
 * install step (its only runtime deps — eventsource-parser, undici — are
 * bundled in). The peerDependencies the dsh host already provides are left
 * external.
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
  // Peer faces provided by the dsh host + React (only used by the client
  // bundle, but kept out of the host file too). Everything else — notably
  // eventsource-parser and undici — is inlined for a self-contained plugin.
  external: ['@deepseek-ai/*', 'cordis', 'schemastery', 'react', 'react/jsx-runtime'],
  // undici (inlined) is CommonJS and calls `require()` for node builtins;
  // esbuild's ESM output turns those into a dynamic-require shim that throws
  // without a real `require`. Provide one anchored at the bundle so the
  // inlined undici can load its builtins.
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n",
  },
});

console.log('uniterra-provider: wrote lib/index.js');

// The sources import siblings with explicit `.ts` extensions
// (allowImportingTsExtensions), and rewriteRelativeImportExtensions does not
// apply to declaration-only emit — the .d.ts files would keep pointing at
// `./x.ts`, which does not exist next to them and breaks type resolution for
// consumers of the published entry. Rewrite relative `.ts` specifiers to
// `.js`: TypeScript resolves `./x.js` to `./x.d.ts` next to it.
const TYPES_DIR = 'lib/types';
const SPECIFIER = /((?:from|import)\s*\(?\s*)'(\.{1,2}\/[^']+?)\.ts'/g;
for (const name of await readdir(TYPES_DIR)) {
  if (!name.endsWith('.d.ts')) continue;
  const file = join(TYPES_DIR, name);
  const source = await readFile(file, 'utf8');
  const rewritten = source.replace(SPECIFIER, "$1'$2.js'");
  if (rewritten !== source) {
    await writeFile(file, rewritten);
    console.log(`uniterra-provider: rewrote .ts specifiers in ${file}`);
  }
}
