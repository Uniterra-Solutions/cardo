#!/usr/bin/env node
/**
 * Prepare the self-contained dsh runtime for packaging.
 *
 * electron-builder cannot resolve pnpm workspace links into the asar (the
 * `@deepseek-ai/dsh` package's transitive deps live in the root store, not
 * under packages/uniterra-desktop/node_modules). Instead we build a flat,
 * self-contained runtime under vendor/dsh-runtime with its own node_modules,
 * then ship it as an extraResource. The main process resolves the dsh CLI
 * from there with a createRequire on its package.json.
 *
 * The runtime is installed OUTSIDE the pnpm workspace (so it is an
 * independent project) with `nodeLinker: hoisted` — pnpm then lays out a
 * flat node_modules with every transitive dep at the top level and (almost)
 * no symlinks, which survives copying and is what electron-builder can ship
 * verbatim.
 *
 * Usage: node scripts/prepare-runtime.mjs [targetDir]
 *   default target: ../../vendor/dsh-runtime (packaged as resources/dsh-runtime)
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const target = process.argv[2] ?? path.resolve(root, 'vendor', 'dsh-runtime');

/** The deps the bundled dsh runtime needs (pinned exact — dsh is a dev
 * preview). These are NOT the desktop package's own deps: the runtime is a
 * self-contained tree installed in its own node_modules. */
function runtimeDeps() {
  return {
    '@deepseek-ai/dsh': '0.1.0-rc.6',
    dshmarket: '1.9.0',
    'dsh-notifier': '0.6.2',
    'dsh-better-sidebar': '0.12.2',
    'dsh-file-upload': '0.4.2',
    'dsh-find-plugin': '0.3.6',
    'dsh-subagent-model-picker': '0.1.1',
    // Vendored (non-npm) plugins: file: refs pull them into the hoisted
    // tree so the dsh loader can resolve the profile bundles from the
    // runtime alone (no pnpm install at app runtime).
    'dsh-deep-whale': `file:${path.join(root, 'vendor', 'dsh-plugins', 'dsh-deep-whale')}`,
  };
}

const tmp = path.join(os.tmpdir(), `uniterra-runtime-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
writeFileSync(
  path.join(tmp, 'package.json'),
  `${JSON.stringify(
    {
      name: 'uniterra-dsh-runtime',
      private: true,
      type: 'module',
      dependencies: runtimeDeps(),
    },
    null,
    2,
  )}\n`,
);
// pnpm 11 reads non-auth settings from pnpm-workspace.yaml (not .npmrc).
// autoInstallPeers: false — some vendored plugins declare peers that only
// exist in the dsh source workspace (not npm); the host tree provides them.
writeFileSync(
  path.join(tmp, 'pnpm-workspace.yaml'),
  'nodeLinker: hoisted\nautoInstallPeers: false\n',
);

execFileSync('pnpm', ['install', '--dir', tmp, '--ignore-scripts'], {
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
});
execFileSync('pnpm', ['rebuild'], {
  cwd: tmp,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
});

// Copy the hoisted tree into the target (regular files — no deref needed).
rmSync(target, { recursive: true, force: true });
mkdirSync(path.dirname(target), { recursive: true });
execFileSync('/bin/cp', ['-R', tmp, target], { stdio: 'inherit' });
rmSync(tmp, { recursive: true, force: true });

console.log(`prepare-runtime: dsh runtime ready at ${target}`);
