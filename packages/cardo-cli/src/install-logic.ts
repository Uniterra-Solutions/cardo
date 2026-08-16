/**
 * Pure install/update business logic for the cardo CLI — no process side
 * effects, so the installer decisions are testable without running a shell
 * (same pattern as stop-app.ts).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = process.env.CARDO_GITHUB_REPO ?? 'Uniterra-Solutions/cardo';

/** The source-archive URL for a release tag (GitHub auto-generates it). */
export function sourceArchiveUrl(tag: string): string {
  return `https://github.com/${REPO}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
}

/** The single extracted source root (GitHub names it `<repo>-<tag>`). */
export async function findSourceRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const roots = entries.filter((e) => e.isDirectory() && e.name.startsWith('cardo-'));
  if (roots.length !== 1) {
    throw new Error(`Unexpected source archive layout under ${dir}`);
  }
  const root = roots[0];
  if (root === undefined) {
    throw new Error(`Unexpected source archive layout under ${dir}`);
  }
  return join(dir, root.name);
}

/** Locate the packaged .app under electron-builder's dist dir. */
export async function findBuiltApp(src: string): Promise<string> {
  const desktopDist = join(src, 'packages', 'cardo-desktop', 'dist');
  const candidates: string[] = [];
  try {
    for (const entry of await readdir(desktopDist, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('mac')) {
        candidates.push(join(desktopDist, entry.name));
      }
    }
  } catch {
    // fall through
  }
  for (const dir of candidates) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        return join(dir, entry.name);
      }
    }
  }
  throw new Error(`No .app bundle found under ${desktopDist}`);
}

export async function readVersion(
  pkgPath = fileURLToPath(new URL('../package.json', import.meta.url)),
): Promise<string> {
  const content = await readFile(pkgPath, 'utf8');
  const match = /^\s*"version"\s*:\s*"([^"]+)"/m.exec(content);
  if (match === null || match[1] === undefined) {
    throw new Error(`Unable to read version from ${pkgPath}`);
  }
  return match[1];
}

export interface ParsedArgs {
  readonly command: 'setup' | 'update' | 'version' | 'help';
  readonly open: boolean;
  readonly dryRun: boolean;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  let open = true;
  let dryRun = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--no-open') {
      open = false;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      positional.push(arg);
    }
  }
  if (positional.some((arg) => arg === '--version' || arg === '-v')) {
    return { command: 'version', open, dryRun };
  }
  const command = positional[0];
  if (command === undefined || command === '--help' || command === '-h') {
    return { command: 'help', open, dryRun };
  }
  if (command === 'setup' || command === 'update') {
    return { command, open, dryRun };
  }
  throw new Error(`Unknown command: ${command} (run "cardo --help" for usage)`);
}
