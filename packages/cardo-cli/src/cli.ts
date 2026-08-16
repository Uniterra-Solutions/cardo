#!/usr/bin/env node
/**
 * Cardo desktop installer CLI.
 *
 * `cardo setup` builds the desktop app ON THE USER'S MACHINE from the
 * release's source archive:
 *   1. Fetch the latest release, download its auto-generated source tarball.
 *   2. Extract it, `pnpm install --frozen-lockfile`, `pnpm run build`.
 *   3. Package the Electron .app with the whole source tree under
 *      `Contents/Resources/src` — the app resolves the bundled dsh CLI,
 *      vendored plugins, and skills from there at runtime, and ensures the
 *      built-ins into the user's normal dsh profile (~/.dsh).
 *   4. Install the .app to ~/Applications and launch.
 *
 * No pre-built binary is downloaded: the source is the artifact, exactly as
 * the repo ships it, which is what makes Windows packaging natural later.
 *
 * `cardo update` updates the CLI ONLY (`npm install -g`); it never rebuilds
 * or reinstalls the desktop app — that is `cardo setup`'s job.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  REPO,
  findBuiltApp,
  findSourceRoot,
  parseArgs,
  readVersion,
  sourceArchiveUrl,
} from './install-logic.js';

const PACKAGE_NAME = '@uniterra-solutions/cardo';
const APP_INSTALL_DIR_NAME = 'Applications';
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

interface LatestRelease {
  readonly tag_name: string;
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES, cwd: options.cwd, env: options.env },
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

/** Fetch the latest release tag, falling back to the newest release when
 * `/releases/latest` 404s (prerelease-only repositories). */
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

async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await run('/usr/bin/tar', ['-xzf', tarPath, '-C', destDir]);
}

/** The single extracted source root (GitHub names it `<repo>-<tag>`). */
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

/**
 * The full install: fetch source, build, package the .app with the source
 * tree in Resources/src, install, and (optionally) launch.
 */
async function installDesktopApp(options: InstallOptions): Promise<void> {
  const release = await fetchLatestRelease();
  const url = sourceArchiveUrl(release.tag_name);

  process.stdout.write(`Downloading source ${release.tag_name}...\n`);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'cardo-'));
  try {
    const tarPath = join(tmpRoot, 'source.tar.gz');
    await downloadFile(url, tarPath);

    const extractDir = join(tmpRoot, 'src');
    await extractTarGz(tarPath, extractDir);
    const src = await findSourceRoot(extractDir);

    if (options.dryRun) {
      process.stdout.write(`[dry-run] Would build from ${src} and install to ~/Applications\n`);
      return;
    }

    process.stdout.write('Installing dependencies...\n');
    // CI=true: the installer may run without a TTY (CI environments, or
    // spawned detached) and pnpm 11 aborts with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY otherwise.
    await run('pnpm', ['install', '--frozen-lockfile'], {
      cwd: src,
      env: { ...process.env, CI: 'true' },
    });
    process.stdout.write('Building packages...\n');
    await run('pnpm', ['run', 'build'], { cwd: src });

    process.stdout.write('Packaging the desktop app...\n');
    await packageApp(src, release.tag_name);

    // Move the packaged .app OUT of the source tree (electron-builder writes
    // it under <src>/packages/cardo-desktop/dist), then embed the source as
    // Resources/src — copying src into its own subdirectory is not allowed,
    // so the .app must leave the tree first.
    const appPath = await findBuiltApp(src);
    const outDir = join(tmpRoot, 'out');
    await mkdir(outDir, { recursive: true });
    const stagedApp = join(outDir, basename(appPath));
    await run('/bin/mv', [appPath, stagedApp]);
    const resourcesSrc = join(stagedApp, 'Contents', 'Resources', 'src');
    await run('/bin/cp', ['-R', src, resourcesSrc]);

    const installed = await installApp(stagedApp);
    process.stdout.write(`Installed ${installed}\n`);
    if (options.open) {
      await openApp(installed);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/** Package the Electron app; the source is embedded afterwards by the caller. */
async function packageApp(src: string, tag: string): Promise<void> {
  const desktopDir = join(src, 'packages', 'cardo-desktop');
  const version = tag.replace(/^v/, '');
  await run(
    'pnpm',
    [
      'exec',
      'electron-builder',
      '--mac',
      '--publish',
      'never',
      `-c.extraMetadata.version=${version}`,
    ],
    { cwd: desktopDir },
  );
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

function printHelp(): void {
  process.stdout.write(
    [
      'cardo — Cardo desktop app installer',
      '',
      'Usage:',
      '  cardo setup [--no-open] [--dry-run]   Build and install the latest Cardo desktop app from source',
      '  cardo update                          Update the CLI only (the desktop app is rebuilt with cardo setup)',
      '  cardo --version                        Print the CLI version',
      '  cardo --help                           Print this help',
      '',
      `First install:  npm install -g ${PACKAGE_NAME} && cardo setup`,
      '',
    ].join('\n'),
  );
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
      await updateCli();
      return;
  }
}

void main().catch((error: unknown) => {
  console.error(`cardo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
