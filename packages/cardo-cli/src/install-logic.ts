/**
 * Pure install/update business logic for the cardo CLI — no process side
 * effects, so the installer decisions are testable without running a shell.
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = process.env.CARDO_GITHUB_REPO ?? 'Uniterra-Solutions/cardo';

/** The install platform the CLI targets on this machine. The CLI is only
 * exercised on macOS and Windows, so every non-win32 platform maps to the
 * macOS flow. */
export type InstallPlatform = 'macos' | 'windows';

export function currentPlatform(): InstallPlatform {
  return process.platform === 'win32' ? 'windows' : 'macos';
}

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

/** Locate the packaged app under electron-builder's dist dir: the `.app`
 * bundle on macOS (`mac-*` dirs), the `win-unpacked/` directory on Windows
 * (the `--win --dir` layout — no NSIS installer, because the source is
 * embedded into the unpacked tree afterwards). */
export async function findBuiltApp(
  src: string,
  platform: InstallPlatform = 'macos',
): Promise<string> {
  const desktopDist = join(src, 'packages', 'cardo-desktop', 'dist');
  if (platform === 'windows') {
    const unpacked = join(desktopDist, 'win-unpacked');
    try {
      const entries = await readdir(unpacked, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.exe'))) {
        return unpacked;
      }
    } catch {
      // fall through
    }
    throw new Error(`No Cardo.exe found under ${desktopDist}`);
  }
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

/** Where the packaged artifact is installed. macOS keeps the `.app` under
 * ~/Applications; Windows installs the unpacked tree under
 * %LOCALAPPDATA%\Programs\Cardo (the per-user install convention). */
export function installDestination(
  platform: InstallPlatform,
  env: NodeJS.ProcessEnv,
  appPath: string,
): string {
  if (platform === 'windows') {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'Programs', 'Cardo');
  }
  return join(homedir(), 'Applications', basename(appPath));
}

/** What to launch after install: the `.app` itself on macOS, `Cardo.exe`
 * inside the install dir on Windows. */
export function launchTarget(platform: InstallPlatform, destination: string): string {
  return platform === 'windows' ? join(destination, 'Cardo.exe') : destination;
}

/** The app's resources dir inside the packaged artifact, where the source
 * tree is embedded (`Contents/Resources` on macOS, `resources` on Windows —
 * both are `process.resourcesPath` at runtime). */
export function embedResourcesDir(platform: InstallPlatform, appRoot: string): string {
  return platform === 'windows'
    ? join(appRoot, 'resources')
    : join(appRoot, 'Contents', 'Resources');
}

/** electron-builder CLI args for the platform. Windows adds `--dir` so the
 * build produces the unpacked `win-unpacked/` layout — the NSIS installer
 * cannot carry the source embedded afterwards. */
export function builderArgs(platform: InstallPlatform, version: string): readonly string[] {
  const args: string[] = [platform === 'windows' ? '--win' : '--mac'];
  if (platform === 'windows') {
    args.push('--dir');
  }
  args.push('--publish', 'never', `-c.extraMetadata.version=${version}`);
  return args;
}

/** Escape a value for a single-quoted PowerShell string (`''` escapes `'`). */
export function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Quote a token for a `shell: true` cmd.exe command line: wrap tokens
 * containing whitespace in double quotes. Windows command lines have no
 * shell escaping of their own, and execFile does not quote shell args. */
export function cmdQuote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

export interface StartMenuShortcut {
  readonly lnkPath: string;
  readonly script: string;
}

/** The Start Menu shortcut spec for the installed Windows app (created via
 * WScript.Shell through powershell). Pure builder — the caller runs it. */
export function startMenuShortcut(exePath: string, env: NodeJS.ProcessEnv): StartMenuShortcut {
  const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const lnkPath = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Cardo.lnk');
  const workingDir = dirname(exePath);
  const script = [
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${psSingleQuote(lnkPath)}');`,
    `$s.TargetPath='${psSingleQuote(exePath)}';`,
    `$s.WorkingDirectory='${psSingleQuote(workingDir)}';`,
    '$s.Save()',
  ].join('');
  return { lnkPath, script };
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
  /** Local source tree for `setup` (skips the release download). */
  readonly source?: string;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  let open = true;
  let dryRun = false;
  let source: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-open') {
      open = false;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--source') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('--source requires a path argument');
      }
      source = value;
      i += 1;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.some((arg) => arg === '--version' || arg === '-v')) {
    return { command: 'version', open, dryRun, source };
  }
  const command = positional[0];
  if (command === undefined || command === '--help' || command === '-h') {
    return { command: 'help', open, dryRun, source };
  }
  if (command === 'setup' || command === 'update') {
    return { command, open, dryRun, source };
  }
  throw new Error(`Unknown command: ${command} (run "cardo --help" for usage)`);
}
