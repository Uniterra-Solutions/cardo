/**
 * Pure install/update business logic for the uniterra CLI — no process side
 * effects, so the installer decisions are testable without running a shell.
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = process.env.UNITERRA_GITHUB_REPO ?? 'Uniterra-Solutions/uniterra';

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

/** Root-level marker shipped in the release's prebuilt source asset. When
 * present, the CLI skips `pnpm run build` — the release workflow already
 * built the tree (tsc/esbuild output is platform-independent). */
export const PREBUILT_MARKER = '.uniterra-prebuilt';

/** A GitHub release asset entry — the fields the source download uses. */
export interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

/** The release asset carrying the source tree WITH built artifacts (built by
 * the release workflow on Linux; one asset serves both install platforms). */
export function sourceAssetName(tag: string): string {
  return `uniterra-src-${tag}.tar.gz`;
}

/** The source download URL for a release: the prebuilt source asset when the
 * release carries one, the GitHub auto-generated archive otherwise (releases
 * predating the asset keep building on the user's machine). */
export function sourceDownloadUrl(tag: string, assets: readonly ReleaseAsset[]): string {
  const match = assets.find((asset) => asset.name === sourceAssetName(tag));
  return match?.browser_download_url ?? sourceArchiveUrl(tag);
}

/** Whether the source root carries the prebuilt marker: the marker alone
 * decides the build skip — a `--source` checkout without it builds as
 * always. A missing root reports false, so the caller builds (and any real
 * error surfaces from the build itself). */
export async function hasPrebuiltSource(root: string): Promise<boolean> {
  try {
    return (await readdir(root)).includes(PREBUILT_MARKER);
  } catch {
    return false;
  }
}

/** How `embedSource` places the source into the packaged app: a DOWNLOADED
 * source on Windows sits on the same volume as the staging dir, so a
 * same-volume rename (robocopy fallback) is instant; every other case
 * copies — a `--source` checkout must NEVER be moved away from the user's
 * tree, whatever volume it is on. */
export function embedStrategy(platform: InstallPlatform, downloaded: boolean): 'move' | 'copy' {
  return platform === 'windows' && downloaded ? 'move' : 'copy';
}

/** Build the message for a failed subprocess: the command line, its exit
 * code, and its captured output — the output is what carries the real
 * failure reason (e.g. electron-builder's binary-download error), which the
 * CLI must never swallow. */
export function commandErrorMessage(
  message: string,
  code: number | string | null | undefined,
  stderr: string,
  stdout: string,
): string {
  const output = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join('\n');
  const suffix = typeof code === 'number' ? ` (exit code ${String(code)})` : '';
  return `${message}${suffix}${output.length > 0 ? `\n${output}` : ''}`;
}

/** The pnpm version pinned by a package.json `packageManager` field, e.g.
 * `"packageManager": "pnpm@11.17.0"` → `"11.17.0"`; undefined when absent. */
export function pnpmVersionFromPackageJson(packageJson: string): string | undefined {
  return /"packageManager"\s*:\s*"pnpm@([^"]+)"/.exec(packageJson)?.[1];
}

/** How to invoke pnpm: the installed binary, or npx (bundled with the npm
 * that ships with the node running this CLI) fetching the pinned version —
 * so a machine without a global pnpm self-provisions instead of failing.
 * Throws when pnpm is missing AND the pin is unknown (no version to fetch). */
export function pnpmInvocation(
  pnpmOnPath: boolean,
  pnpmVersion: string | undefined,
): { readonly file: string; readonly args: readonly string[] } {
  if (pnpmOnPath) {
    return { file: 'pnpm', args: [] };
  }
  if (pnpmVersion === undefined) {
    throw new Error(
      'pnpm is not installed and the source tree has no packageManager pin — cannot self-provision pnpm',
    );
  }
  return { file: 'npx', args: ['--yes', `pnpm@${pnpmVersion}`] };
}

/** The single extracted source root (GitHub names it `<repo>-<tag>`). */
export async function findSourceRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const roots = entries.filter((e) => e.isDirectory() && e.name.startsWith('uniterra-'));
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
  const desktopDist = join(src, 'packages', 'uniterra-desktop', 'dist');
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
    throw new Error(`No Uniterra.exe found under ${desktopDist}`);
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
 * %LOCALAPPDATA%\Programs\Uniterra (the per-user install convention). */
export function installDestination(
  platform: InstallPlatform,
  env: NodeJS.ProcessEnv,
  appPath: string,
): string {
  if (platform === 'windows') {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'Programs', 'Uniterra');
  }
  return join(homedir(), 'Applications', basename(appPath));
}

/** What to launch after install: the `.app` itself on macOS, `Uniterra.exe`
 * inside the install dir on Windows. */
export function launchTarget(platform: InstallPlatform, destination: string): string {
  return platform === 'windows' ? join(destination, 'Uniterra.exe') : destination;
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
  const lnkPath = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Uniterra.lnk');
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

/** The ordered execution stages of a uniterra CLI run. Pure so the
 * command/flag semantics are testable without running a shell.
 *
 * `uniterra update` is the one-command full update: it refreshes the CLI
 * itself first (fail fast on npm/permission problems before the long build),
 * then rebuilds + reinstalls the desktop app exactly like `uniterra setup`,
 * and relaunches the app when done — the desktop's Update Now flow quits
 * the app and runs this command, so the relaunch IS the app restart. */
export type InstallStage = 'update-cli' | 'build-install-app' | 'launch-app';

export function installPlan(
  command: 'setup' | 'update',
  open: boolean,
  dryRun: boolean,
): readonly InstallStage[] {
  if (dryRun) {
    return [];
  }
  const stages: InstallStage[] = [];
  if (command === 'update') {
    stages.push('update-cli');
  }
  stages.push('build-install-app');
  if (open) {
    stages.push('launch-app');
  }
  return stages;
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
  throw new Error(`Unknown command: ${command} (run "uniterra --help" for usage)`);
}
