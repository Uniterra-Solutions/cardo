/**
 * Cardo desktop profile bootstrap.
 *
 * The cardo desktop app runs a bundled DeepSeek Harness (dsh) runtime under
 * its OWN data home (Electron userData dir), never the user's personal
 * `~/.dsh`. On first launch it scaffolds a `cardo` profile there — the
 * official bundles (`dsh-base` + `dsh-web-app`) resolve from the bundled dsh
 * CLI's dependency tree, and the pinned community plugins are registered as
 * bundles so `dsh plugin` installs their node_modules into the profile.
 *
 * This module is pure fs work, testable without Electron.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** The npm-published community plugins the cardo profile mounts, in add order. */
export const PROFILE_PLUGINS: readonly string[] = [
  'dshmarket@1.9.0',
  'dsh-notifier@0.6.2',
  'dsh-better-sidebar@0.12.2',
  'dsh-file-upload@0.4.2',
  'dsh-lan-gateway@0.2.1',
  'dsh-find-plugin@0.3.6',
  'dsh-subagent-model-picker@0.1.1',
] as const;

/** Vendored (non-npm) community plugins, installed from the monorepo checkout
 * at build time. The `vendor/dsh-plugins` pin ledger records their commits. */
export const VENDOR_PLUGIN_DIRS: readonly string[] = [
  'deep-whale-day-night-theme',
  'dsh-subagent-monitor',
  'dsh-thinking-effort',
] as const;

/** The official dsh bundles every profile stacks (resolved from the dsh CLI). */
export const OFFICIAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
] as const;

/** Build scripts the profile pnpm must be allowed to run (pnpm 11 blocks by default). */
export const PROFILE_ALLOW_BUILDS: readonly string[] = [
  'node-pty',
  'sharp',
  'protobufjs',
  'fsevents',
  'tesseract.js',
  '@google/genai',
  'electron',
  'electron-winstaller',
  'esbuild',
  'koffi',
] as const;

/** The profile package.json the launcher scaffolds on first run. */
export function profileManifest(): string {
  return JSON.stringify(
    {
      name: 'dsh-profile-cardo',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: [
            ...OFFICIAL_BUNDLES,
            ...PROFILE_PLUGINS.map((p) => p.split('@')[0] as string),
            ...VENDOR_PLUGIN_DIRS.map((dir) => dir),
          ],
        },
      },
    },
    null,
    2,
  );
}

/** The pnpm workspace file needed so plugin installs allow native builds. */
export function profilePnpmWorkspace(): string {
  const lines = ['allowBuilds:'];
  for (const pkg of PROFILE_ALLOW_BUILDS) {
    lines.push(`  ${pkg}: true`);
  }
  lines.push('minimumReleaseAge: 0', '');
  return lines.join('\n');
}

/**
 * Scaffold the cardo dsh profile under `dshHome/profiles/cardo` if it does
 * not exist yet, then install the pinned plugins with the bundled dsh CLI.
 * Idempotent: an existing profile (user's edits, sessions) is never touched.
 *
 * @param dshHome the app-owned DSH_HOME directory.
 * @param dshCli absolute path to the bundled dsh CLI entry (lib/bin.js).
 * @param nodeExec the node executable to run it with (process.execPath under
 *   Electron is the Electron binary; ELECTRON_RUN_AS_NODE=1 makes it a node).
 * @param vendorRoot absolute path to the vendored plugins dir
 *   (`vendor/dsh-plugins`); used to install the non-npm plugins.
 */
export function ensureCardoProfile(
  dshHome: string,
  dshCli: string,
  nodeExec: string,
  vendorRoot: string,
): void {
  const profileDir = join(dshHome, 'profiles', 'cardo');
  if (profileExists(profileDir)) {
    return;
  }
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), `${profileManifest()}\n`, 'utf8');
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), profilePnpmWorkspace(), 'utf8');

  const baseEnv = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' };
  for (const plugin of PROFILE_PLUGINS) {
    execFileSync(nodeExec, [dshCli, 'plugin', '--profile', 'cardo', 'add', plugin], {
      env: baseEnv,
      stdio: 'inherit',
    });
  }
  for (const dir of VENDOR_PLUGIN_DIRS) {
    execFileSync(nodeExec, [dshCli, 'plugin', '--profile', 'cardo', 'add', join(vendorRoot, dir)], {
      env: baseEnv,
      stdio: 'inherit',
    });
  }
}

function profileExists(profileDir: string): boolean {
  try {
    return (
      readFileSync(join(profileDir, 'package.json'), 'utf8').includes('dsh-profile-cardo') &&
      exists(join(profileDir, 'cordis.patch.yml'))
    );
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    readFileSync(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}
