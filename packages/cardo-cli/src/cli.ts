#!/usr/bin/env node
import { execFile, type ExecFileException } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { stopRunningAppInstances, type ProcessOps } from './stop-app.js';

const REPO = process.env.CARDO_GITHUB_REPO ?? 'Uniterra-Solutions/cardo';
const PACKAGE_NAME = '@cardo/cardo-cli';
const APP_INSTALL_DIR_NAME = 'Applications';
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface LatestRelease {
  readonly tag_name: string;
  readonly assets: readonly ReleaseAsset[];
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

function run(file: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error !== null) {
          reject(new Error(error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('cardo currently only supports macOS');
  }
}

function currentArch(): string {
  if (process.arch === 'arm64' || process.arch === 'x64') {
    return process.arch;
  }
  throw new Error(
    `Unsupported CPU architecture: ${process.arch} (only arm64/x64 macOS is supported)`,
  );
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cardo-cli' };
  const latestResponse = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers,
  });
  if (latestResponse.ok) {
    return (await latestResponse.json()) as LatestRelease;
  }
  if (latestResponse.status === 404) {
    // `/releases/latest` only returns non-prerelease releases; fall back to the
    // newest release (which may be a prerelease) so beta tags still install.
    const listResponse = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
      headers,
    });
    if (!listResponse.ok) {
      throw new Error(
        `Unable to fetch releases of ${REPO} (HTTP ${String(listResponse.status)}). ` +
          'Make sure a release exists and the repository is public.',
      );
    }
    const releases = (await listResponse.json()) as LatestRelease[];
    const newest = releases[0];
    if (newest === undefined) {
      throw new Error(`No releases found for ${REPO}.`);
    }
    return newest;
  }
  throw new Error(
    `Unable to fetch the latest release of ${REPO} (HTTP ${String(latestResponse.status)}). ` +
      'Make sure a release exists and the repository is public.',
  );
}

function findZipAsset(release: LatestRelease, arch: string): ReleaseAsset {
  const suffix = `-${arch}.zip`;
  const asset = release.assets.find((candidate) => candidate.name.endsWith(suffix));
  if (asset === undefined) {
    throw new Error(
      `No ${suffix} asset in release ${release.tag_name}; available assets: ` +
        release.assets.map((candidate) => candidate.name).join(', '),
    );
  }
  return asset;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${String(response.status)} ${response.statusText}`);
  }
  if (response.body === null) {
    throw new Error(`Download failed: empty response body for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, destDir]);
}

async function findAppBundle(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (appEntry === undefined) {
    throw new Error(`No .app bundle found inside the release archive (${dir})`);
  }
  return join(dir, appEntry.name);
}

async function installApp(appPath: string): Promise<string> {
  const targetDir = join(homedir(), APP_INSTALL_DIR_NAME);
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, basename(appPath));
  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
  }
  await run('/usr/bin/ditto', [appPath, target]);
  await rm(appPath, { recursive: true, force: true });
  return target;
}

async function openApp(appPath: string): Promise<void> {
  await run('/usr/bin/open', [appPath]);
}

interface InstallOptions {
  readonly open: boolean;
  readonly dryRun: boolean;
}

async function installDesktopApp(options: InstallOptions): Promise<void> {
  assertMacOS();
  const release = await fetchLatestRelease();
  const asset = findZipAsset(release, currentArch());

  process.stdout.write(`Downloading ${asset.name} (${release.tag_name})...\n`);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'cardo-'));
  try {
    const zipPath = join(tmpRoot, asset.name);
    await downloadFile(asset.browser_download_url, zipPath);

    const extractDir = join(tmpRoot, 'extract');
    await mkdir(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    const appPath = await findAppBundle(extractDir);
    const target = join(homedir(), APP_INSTALL_DIR_NAME, basename(appPath));

    if (options.dryRun) {
      process.stdout.write(`[dry-run] Would install ${basename(appPath)} to ${target}\n`);
      return;
    }

    const installed = await installApp(appPath);
    process.stdout.write(`Installed ${installed}\n`);
    if (options.open) {
      await openApp(installed);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function realProcessOps(): ProcessOps {
  return {
    pgrep: async (bundleName: string): Promise<number[]> => {
      try {
        // pgrep exits 1 (and prints nothing) when nothing matches.
        const { stdout } = await run('/usr/bin/pgrep', ['-f', `${bundleName}.app`]);
        return stdout
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => Number(line))
          .filter((pid) => Number.isInteger(pid) && pid > 0);
      } catch {
        return [];
      }
    },
    osascriptQuit: async (bundleName: string): Promise<void> => {
      await run('/usr/bin/osascript', ['-e', `tell application "${bundleName}" to quit`]);
    },
    kill: async (pids: readonly number[], signal: NodeJS.Signals): Promise<void> => {
      if (pids.length === 0) {
        return;
      }
      await run('/bin/kill', ['-s', signal, ...pids.map((pid) => String(pid))]);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function stopRunningApps(): Promise<void> {
  process.stdout.write('Stopping running Cardo app instances...\n');
  await stopRunningAppInstances(realProcessOps());
}

async function updateCli(): Promise<void> {
  process.stdout.write(`Updating CLI (${PACKAGE_NAME})...\n`);
  try {
    const { stdout } = await run('npm', ['install', '-g', `${PACKAGE_NAME}@latest`]);
    if (stdout.trim().length > 0) {
      process.stdout.write(stdout);
    }
  } catch (error) {
    throw new Error(
      `Failed to update the CLI: ${error instanceof Error ? error.message : String(error)} ` +
        '(if this is a permissions error, use a user-level npm prefix or nvm, or rerun with sudo)',
    );
  }
}

async function readVersion(): Promise<string> {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const content = await readFile(pkgPath, 'utf8');
  const match = /^\s*"version"\s*:\s*"([^"]+)"/m.exec(content);
  if (match === null || match[1] === undefined) {
    throw new Error(`Unable to read version from ${pkgPath}`);
  }
  return match[1];
}

function printHelp(): void {
  process.stdout.write(
    [
      'cardo — Cardo desktop app installer',
      '',
      'Usage:',
      '  cardo setup [--no-open] [--dry-run]   Download and install the latest Cardo macOS app',
      '  cardo update [--no-open] [--dry-run]  Update the CLI and reinstall the latest app',
      '  cardo --version                        Print the CLI version',
      '  cardo --help                           Print this help',
      '',
      `First install:  npm install -g ${PACKAGE_NAME} && cardo setup`,
      '',
    ].join('\n'),
  );
}

interface ParsedArgs {
  readonly command: 'setup' | 'update' | 'version' | 'help';
  readonly open: boolean;
  readonly dryRun: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.command) {
    case 'help':
      printHelp();
      return;
    case 'version':
      process.stdout.write(`${await readVersion()}\n`);
      return;
    case 'setup':
      await installDesktopApp({ open: parsed.open, dryRun: parsed.dryRun });
      return;
    case 'update':
      if (!parsed.dryRun) {
        await stopRunningApps();
      }
      await updateCli();
      await installDesktopApp({ open: parsed.open, dryRun: parsed.dryRun });
      return;
  }
}

void main().catch((error: unknown) => {
  console.error(`cardo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
