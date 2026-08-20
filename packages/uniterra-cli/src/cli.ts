#!/usr/bin/env node
/**
 * Uniterra desktop installer CLI.
 *
 * `uniterra setup` builds the desktop app from the release's source:
 *   1. Fetch the latest release, download its source — the prebuilt source
 *      asset (`uniterra-src-<tag>.tar.gz`, CI-built dist/lib + a `.uniterra-prebuilt`
 *      marker) when the release carries one, else the auto-generated tarball.
 *   2. Extract it, `pnpm install --frozen-lockfile`, then `pnpm run build`
 *      only when the prebuilt marker is absent (old releases and --source
 *      checkouts build as before; the asset skips it).
 *   3. Package the Electron app, then embed the whole source tree into the
 *      app resources — the app resolves the bundled dsh CLI, vendored
 *      plugins, and skills from there at runtime, and ensures the built-ins
 *      into the user's normal dsh profile (~/.dsh).
 *   4. Install and launch:
 *      - macOS: the .app goes to ~/Applications; the source embeds under
 *        Contents/Resources/src.
 *      - Windows: `--win --dir` produces the unpacked win-unpacked/ layout
 *        (the NSIS installer cannot carry the source embedded afterwards);
 *        it installs to %LOCALAPPDATA%\Programs\Uniterra with a Start Menu
 *        shortcut, the source embeds under resources/src (the shell resolves
 *        it via process.resourcesPath), and the app launches as Uniterra.exe.
 *
 * No pre-built binary is downloaded: the source is the artifact — built
 * ahead of time by CI when the release asset exists.
 *
 * `uniterra setup --source <dir>` builds from a local workspace checkout
 * instead of downloading a release — the Windows CI verification path.
 * `--move-source` opts a disposable `--source` checkout into the same
 * same-volume move (instant) that a downloaded release source gets, instead
 * of the always-copy default, so the verification replays the closer-to-real
 * user flow instead of paying for a full-tree robocopy.
 *
 * `uniterra update` is the one-command full update: it refreshes the CLI
 * itself (`npm install -g`), then rebuilds + reinstalls the desktop app
 * from the latest release source exactly like `uniterra setup`, and relaunches
 * the app when done. The desktop's Update Now flow quits the app and runs
 * this command, so the relaunch IS the app restart — no separate
 * `uniterra setup` needed.
 */

import { execFile, spawn, type ExecFileException } from 'node:child_process';
import { createWriteStream, existsSync, type Dirent } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  REPO,
  builderArgs,
  cmdQuote,
  commandErrorMessage,
  currentPlatform,
  embedResourcesDir,
  embedStrategy,
  findBuiltApp,
  findSourceRoot,
  hasPrebuiltSource,
  installDestination,
  installPlan,
  launchTarget,
  parseArgs,
  pnpmInvocation,
  pnpmVersionFromPackageJson,
  readVersion,
  remapJunctionTarget,
  sourceDownloadUrl,
  startMenuShortcut,
  type InstallPlatform,
  type ReleaseAsset,
} from './install-logic.js';

const PACKAGE_NAME = '@uniterra-solutions/uniterra';
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
/** robocopy exit codes 0-7 are success (bitmask: 1=copied, 2=extra, 4=mismatch). */
const ROBOCOPY_SUCCESS_MAX = 7;
/** /MT:16 — multi-threaded copy: the embedded source tree is hundreds of
 * thousands of small files (pnpm store), where single-threaded robocopy
 * takes minutes and parallel threads finish in seconds.
 * /R:5 /W:5 — bounded retries: robocopy's defaults (1,000,000 retries,
 * 30 s apart) hang for hours when Defender briefly locks a freshly copied
 * file. */
const ROBOCOPY_QUIET = [
  '/E',
  '/MT:16',
  '/R:5',
  '/W:5',
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/NC',
  '/NS',
  '/NP',
] as const;

interface LatestRelease {
  readonly tag_name: string;
  readonly assets?: readonly ReleaseAsset[];
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a CLI tool via execFile. Windows ships npm/pnpm/uniterra as `.cmd`
 * shims, which execFile cannot launch directly (spawn ENOENT) — there
 * `shell: true` lets cmd.exe resolve them via PATHEXT, the same pattern dsh
 * uses for its plugin spawns. `.exe` tools (tar, robocopy, powershell) would
 * resolve either way; args containing whitespace are quoted for cmd.exe. */
function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile(
      file,
      windows ? args.map(cmdQuote) : [...args],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        cwd: options.cwd,
        env: options.env,
        shell: windows,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error !== null) {
          reject(new Error(commandErrorMessage(error.message, error.code, stderr, stdout)));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** How to run pnpm for this install. The CLI itself runs on node, so node
 * (with its bundled npm/npx) is guaranteed; pnpm is the only tool that can be
 * absent. When it's missing, npx fetches the exact version the source tree
 * pins (`packageManager` field), so the install self-provisions instead of
 * failing on a machine without a global pnpm. */
async function resolvePnpm(src: string): Promise<{ file: string; args: readonly string[] }> {
  let onPath = false;
  try {
    await run('pnpm', ['--version']);
    onPath = true;
  } catch {
    // not installed — self-provision via npx below
  }
  const packageJson = await readFile(join(src, 'package.json'), 'utf8');
  return pnpmInvocation(onPath, pnpmVersionFromPackageJson(packageJson));
}

/** Windows recursive copy. Robocopy's exit code is a bitmask where 0-7 all
 * mean success, so a non-zero exit is not a failure unless it is >= 8. */
function robocopy(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'robocopy',
      [from, to, ...ROBOCOPY_QUIET],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES },
      (error: ExecFileException | null, _stdout: string, stderr: string) => {
        if (error === null) {
          resolve();
          return;
        }
        const code = typeof error.code === 'number' ? error.code : Number.NaN;
        if (Number.isFinite(code) && code <= ROBOCOPY_SUCCESS_MAX) {
          resolve();
          return;
        }
        reject(
          new Error(
            `robocopy ${from} -> ${to} failed (${String(error.code)}): ${error.message}` +
              (stderr.trim().length > 0 ? `\n${stderr.trim()}` : ''),
          ),
        );
      },
    );
  });
}

/** Fetch the latest release tag, falling back to the newest release when
 * `/releases/latest` 404s (prerelease-only repositories). */
async function fetchLatestRelease(): Promise<LatestRelease> {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'uniterra-cli' };
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

async function extractTarGz(
  tarPath: string,
  destDir: string,
  platform: InstallPlatform,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  // Windows 10+ ships bsdtar on PATH; macOS keeps /usr/bin/tar.
  await run(platform === 'windows' ? 'tar' : '/usr/bin/tar', ['-xzf', tarPath, '-C', destDir]);
}

interface InstallOptions {
  readonly open: boolean;
  readonly dryRun: boolean;
  readonly source?: string;
  /** Opt-in: embed a `--source` checkout via same-volume move (disposable). */
  readonly moveSource: boolean;
}

interface ResolvedSource {
  readonly src: string;
  readonly version: string;
  /** True when the CLI downloaded the release source into its own tmp tree
   * (safe to rename when embedding); false for a `--source` local checkout,
   * which must never be moved away from the user's working copy. */
  readonly downloaded: boolean;
}

/** Resolve the source tree to build. `--source` uses a local workspace
 * checkout; the default downloads the latest release archive. Returns
 * undefined after a dry-run report. */
async function resolveInstallSource(
  options: InstallOptions,
  tmpRoot: string,
): Promise<ResolvedSource | undefined> {
  const platform = currentPlatform();
  if (options.source !== undefined) {
    if (!existsSync(join(options.source, 'packages', 'uniterra-desktop', 'package.json'))) {
      throw new Error(
        `--source ${options.source} does not look like a uniterra workspace ` +
          '(packages/uniterra-desktop/package.json missing)',
      );
    }
    if (options.dryRun) {
      process.stdout.write(
        `[dry-run] Would build from ${options.source} and install for ${platform}\n`,
      );
      return undefined;
    }
    const version = await readVersion(
      join(options.source, 'packages', 'uniterra-desktop', 'package.json'),
    );
    return { src: options.source, version, downloaded: false };
  }

  const release = await fetchLatestRelease();
  process.stdout.write(`Downloading source ${release.tag_name}...\n`);
  const tarPath = join(tmpRoot, 'source.tar.gz');
  await downloadFile(sourceDownloadUrl(release.tag_name, release.assets ?? []), tarPath);
  const extractDir = join(tmpRoot, 'src');
  await extractTarGz(tarPath, extractDir, platform);
  const src = await findSourceRoot(extractDir);
  if (options.dryRun) {
    process.stdout.write(`[dry-run] Would build from ${src} and install for ${platform}\n`);
    return undefined;
  }
  return { src, version: release.tag_name.replace(/^v/, ''), downloaded: true };
}

/** Windows: move a directory, preferring an instant same-volume rename.
 * Rename is only an optimization — ANY failure degrades to a robocopy copy +
 * delete: EXDEV (cross-volume, e.g. CI workspace on D: vs temp on C:), EPERM
 * (Defender briefly locking freshly copied files), or anything else. The
 * fallback surfaces real problems through robocopy's own exit code. */
async function moveOrRobocopy(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch {
    // fall through to robocopy
  }
  await robocopy(from, to);
  await rm(from, { recursive: true, force: true });
}

/** Move the packaged artifact out of the source tree (it must leave before
 * the source is embedded, or the copy would recurse into itself). */
async function moveArtifact(
  appPath: string,
  staged: string,
  platform: InstallPlatform,
): Promise<void> {
  if (platform === 'windows') {
    // `--source` checkouts can live on another volume than the tmp dir
    // (e.g. CI: workspace on D:, temp on C:) — rename fails there with
    // EXDEV and the helper falls back to copy + delete.
    await moveOrRobocopy(appPath, staged);
    return;
  }
  // /bin/mv survives cross-volume moves (copy + delete internally).
  await run('/bin/mv', [appPath, staged]);
}

/** Windows-only: re-point every pnpm junction whose absolute target still
 * points into the staging tree, so the installed source is self-contained.
 * A same-volume `rename` (how a downloaded source is embedded AND how the app
 * is installed) preserves junction reparse points verbatim, so after the
 * staging tree is deleted every junction is a dead link (ERR_MODULE_NOT_FOUND
 * on boot). The remap is {@link remapJunctionTarget}: strip the staging prefix
 * and re-root it under the installed source dir. A tree already materialized
 * by robocopy carries no junctions, so the walk is a no-op there. */
async function repointJunctions(embeddedSrc: string, stagingSrc: string): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  await repointJunctionTree(embeddedSrc, stagingSrc, embeddedSrc);
}

async function repointJunctionTree(
  dir: string,
  stagingRoot: string,
  embeddedRoot: string,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // An unreadable directory (most critically the embedded source root, which
    // would skip the whole re-point) must not fail silently.
    console.warn(`uniterra: skipping unreadable directory ${dir} during junction re-point:`, error);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // A junction is reported as a link — re-point it, never descend into it.
      await repointOneJunction(full, stagingRoot, embeddedRoot);
    } else if (entry.isDirectory()) {
      await repointJunctionTree(full, stagingRoot, embeddedRoot);
    }
  }
}

async function repointOneJunction(
  path: string,
  stagingRoot: string,
  embeddedRoot: string,
): Promise<void> {
  let target: string;
  try {
    target = await readlink(path);
  } catch {
    return; // not a readable link — leave it
  }
  const remapped = remapJunctionTarget(target, stagingRoot, embeddedRoot);
  if (remapped === undefined) {
    return; // target not under staging — an unexpected link we must not touch
  }
  // Create the replacement at a temp name FIRST so a failure to create it
  // (e.g. an over-long target) leaves the original junction in place, then
  // swap it over. Either failure propagates — a broken link must abort the
  // install rather than ship silently.
  const tmpPath = `${path}.uniterra-repoint`;
  await symlink(remapped, tmpPath, 'junction');
  await unlink(path);
  await rename(tmpPath, path);
}

/** Embed the source tree into the packaged app's resources dir. A DOWNLOADED
 * source on Windows is renamed into the app (same volume — instant, robocopy
 * fallback on EXDEV/EPERM); a `--source` checkout is always copied so the
 * user's working tree stays put. macOS copies (APFS clonefile is already
 * near-instant). */
async function embedSource(
  staged: string,
  src: string,
  platform: InstallPlatform,
  strategy: 'move' | 'copy',
): Promise<void> {
  const target = join(embedResourcesDir(platform, staged), 'src');
  if (platform === 'windows') {
    if (strategy === 'move') {
      await moveOrRobocopy(src, target);
      return;
    }
    await robocopy(src, target);
    return;
  }
  await run('/bin/cp', ['-R', src, target]);
}

/** Install the staged artifact to its destination, replacing any previous
 * install. Windows prefers a same-volume rename (tmp and %LOCALAPPDATA% are
 * both on C:) over a multi-GB robocopy; macOS keeps /usr/bin/ditto. */
async function copyInstalled(
  staged: string,
  destination: string,
  platform: InstallPlatform,
): Promise<void> {
  if (existsSync(destination)) {
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(dirname(destination), { recursive: true });
  if (platform === 'windows') {
    await moveOrRobocopy(staged, destination);
    return;
  }
  await run('/usr/bin/ditto', [staged, destination]);
}

/** Create the Start Menu shortcut for the installed Windows app. Best
 * effort: a missing shortcut must never fail the install. */
async function createStartMenuShortcutBestEffort(destination: string): Promise<void> {
  try {
    const shortcut = startMenuShortcut(launchTarget('windows', destination), process.env);
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', shortcut.script]);
  } catch (error) {
    console.warn(
      `uniterra: skipping Start Menu shortcut: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function openApp(destination: string, platform: InstallPlatform): Promise<void> {
  if (platform === 'windows') {
    // Launch detached: `/usr/bin/open`-style, the CLI must not wait for the
    // GUI app to exit.
    const child = spawn(launchTarget(platform, destination), {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', (error: Error) => {
      console.error('uniterra: failed to launch the app:', error);
    });
    child.unref();
    return;
  }
  await run('/usr/bin/open', [destination]);
}

/**
 * Build the app from source, package it with the source tree embedded in
 * the resources, and install it. Returns the install destination —
 * launching is the caller's `launch-app` stage. Returns undefined after a
 * dry-run report.
 */
async function buildInstallApp(options: InstallOptions): Promise<string | undefined> {
  const platform = currentPlatform();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'uniterra-'));
  try {
    const resolved = await resolveInstallSource(options, tmpRoot);
    if (resolved === undefined) {
      return undefined; // dry-run reported already
    }
    const { src, version } = resolved;
    const pnpm = await resolvePnpm(src);

    process.stdout.write('Installing dependencies...\n');
    // CI=true: the installer may run without a TTY (CI environments, or
    // spawned detached) and pnpm 11 aborts with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY otherwise.
    await run(pnpm.file, [...pnpm.args, 'install', '--frozen-lockfile'], {
      cwd: src,
      env: { ...process.env, CI: 'true' },
    });
    if (await hasPrebuiltSource(src)) {
      // The release asset ships the built tree (CI built it on Linux, and
      // tsc/esbuild output is platform-independent), so the multi-minute
      // build is skipped. Pre-asset releases and --source checkouts have no
      // marker and build exactly as before.
      process.stdout.write('Prebuilt artifacts found — skipping the workspace build.\n');
    } else {
      process.stdout.write('Building packages...\n');
      await run(pnpm.file, [...pnpm.args, 'run', 'build'], { cwd: src });
    }

    process.stdout.write('Packaging the desktop app...\n');
    await packageApp(src, version, platform, pnpm);

    // Move the packaged artifact OUT of the source tree (electron-builder
    // writes it under <src>/packages/uniterra-desktop/dist), then embed the
    // source — copying src into its own subdirectory is not allowed, so the
    // artifact must leave the tree first.
    const appPath = await findBuiltApp(src, platform);
    const outDir = join(tmpRoot, 'out');
    await mkdir(outDir, { recursive: true });
    const staged = join(outDir, basename(appPath));
    await moveArtifact(appPath, staged, platform);
    // This step moves/copies hundreds of thousands of small files (the
    // embedded node_modules) — the line before it keeps the install log
    // readable.
    process.stdout.write('Embedding source tree into the app...\n');
    await embedSource(
      staged,
      src,
      platform,
      embedStrategy(platform, resolved.downloaded, options.moveSource),
    );

    const destination = installDestination(platform, process.env, staged);
    process.stdout.write(`Installing to ${destination}...\n`);
    await copyInstalled(staged, destination, platform);
    if (platform === 'windows') {
      // The same-volume renames that embedded and installed the source
      // preserved pnpm's junction reparse points verbatim, so they still name
      // the (now-deleted) staging tree. Re-point them against the FINAL
      // installed source dir — the embed-time path is wrong because the
      // install rename breaks it again.
      await repointJunctions(join(embedResourcesDir(platform, destination), 'src'), src);
    }
    await rm(staged, { recursive: true, force: true });
    if (platform === 'windows') {
      await createStartMenuShortcutBestEffort(destination);
    }
    process.stdout.write(`Installed ${destination}\n`);
    return destination;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/** Execute the command's stage plan (`installPlan`). `uniterra update` runs
 * `update-cli` first so npm/permission problems surface before the long
 * build; `launch-app` is the relaunch after an update (the desktop quits
 * itself before running `uniterra update`, so launching the installed app is
 * the restart). */
async function runInstallPlan(command: 'setup' | 'update', options: InstallOptions): Promise<void> {
  const plan = installPlan(command, options.open, options.dryRun);
  if (plan.length === 0) {
    if (command === 'update') {
      // The plan report is complete on its own — no source resolution, no
      // downloads (keeps `uniterra update --dry-run` deterministic and offline).
      process.stdout.write(
        '[dry-run] Would update the CLI, then rebuild + reinstall the desktop app and relaunch it\n',
      );
      return;
    }
    // Setup dry-run: resolve the source for the report only (prints and returns).
    const tmpRoot = await mkdtemp(join(tmpdir(), 'uniterra-'));
    try {
      await resolveInstallSource(options, tmpRoot);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
    return;
  }
  let destination: string | undefined;
  for (const stage of plan) {
    switch (stage) {
      case 'update-cli':
        await updateCli();
        break;
      case 'build-install-app':
        destination = await buildInstallApp(options);
        break;
      case 'launch-app':
        if (destination !== undefined) {
          await openApp(destination, currentPlatform());
        }
        break;
    }
  }
}

/** Package the Electron app; the source is embedded afterwards by the caller. */
async function packageApp(
  src: string,
  version: string,
  platform: InstallPlatform,
  pnpm: { file: string; args: readonly string[] },
): Promise<void> {
  const desktopDir = join(src, 'packages', 'uniterra-desktop');
  await run(
    pnpm.file,
    [...pnpm.args, 'exec', 'electron-builder', ...builderArgs(platform, version)],
    {
      cwd: desktopDir,
    },
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
        '(if this is a permissions error, use a user-level npm prefix or a Node version manager, or rerun with elevated permissions)',
    );
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'uniterra — Uniterra desktop app installer',
      '',
      'Usage:',
      '  uniterra setup [--source <dir>] [--no-open] [--dry-run]   Build and install the latest Uniterra desktop app from source',
      '  uniterra update [--source <dir>] [--no-open] [--dry-run]  Update the CLI, then rebuild + reinstall the app and relaunch it',
      '  uniterra --version                        Print the CLI version',
      '  uniterra --help                           Print this help',
      '',
      '    --source <dir>  build from a local uniterra workspace instead of downloading the latest release',
      '    --move-source   treat the --source checkout as disposable and move it into the app (same-volume',
      '                    rename) instead of copying — for throwaway checkouts only (CI verification); the',
      '                    tree must not be a working copy you want to keep',
      '    --no-open       install without launching the app',
      '    --dry-run       resolve the source and report without installing',
      '',
      'Install targets: macOS → ~/Applications/Uniterra.app; Windows → %LOCALAPPDATA%\\Programs\\Uniterra',
      '',
      `First install:  npm install -g ${PACKAGE_NAME} && uniterra setup`,
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
    case 'update':
      await runInstallPlan(parsed.command, {
        open: parsed.open,
        dryRun: parsed.dryRun,
        source: parsed.source,
        moveSource: parsed.moveSource,
      });
      return;
  }
}

void main().catch((error: unknown) => {
  console.error(`uniterra: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
