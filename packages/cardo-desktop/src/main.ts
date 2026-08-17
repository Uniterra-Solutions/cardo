/**
 * Cardo desktop main — Electron shell over DeepSeek Harness.
 *
 * Cardo IS the dsh desktop surface: it runs the bundled dsh CLI against the
 * user's normal dsh configuration (`~/.dsh`, the default DSH_HOME). The user
 * configures providers/plugins in the app exactly as in dsh — no separate
 * app-owned home, no seeding, no profile scaffolding.
 *
 * Startup sequence:
 *   1. Single-instance lock.
 *   2. Spawn the bundled dsh CLI (`node lib/bin.js --profile web`), wait for
 *      its readiness URL.
 *   3. Open a BrowserWindow on that URL; window close shuts dsh down.
 *   4. Crash-restart the runtime with a bounded backoff.
 */

import { app, BrowserWindow, dialog, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDsh, stopDsh, type DshRuntimeHandle } from './dsh-process.js';
import { ensureBuiltinPlugins } from './builtin.js';
import { resolveCardoUpdateStatus, shouldPromptForUpdate } from '@cardo/cardo-updater';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bundled source tree the app was built from. `cardo setup` embeds the
 * extracted release source under `Contents/Resources/src`; the app resolves
 * the dsh CLI, vendored plugins, and skills from there. In dev the app runs
 * from the monorepo, so the source root is the repo root.
 */
function bundledSrcRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'src');
  }
  return path.resolve(here, '..', '..', '..');
}

/** Resolve the bundled dsh CLI entry from the source tree. In the pnpm
 * workspace `@deepseek-ai/dsh` is a devDependency of the cardo-desktop
 * package, so pnpm links it under `packages/cardo-desktop/node_modules`
 * (never the workspace root). Dev and packaged both resolve it there. */
function dshCliPath(): string {
  return path.join(
    bundledSrcRoot(),
    'packages',
    'cardo-desktop',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

/** Vendored (non-npm) plugin sources inside the source tree. */
function vendorPluginsRoot(): string {
  return path.join(bundledSrcRoot(), 'vendor', 'dsh-plugins');
}

/** Bundled company skills inside the source tree. */
function skillsDir(): string {
  return path.join(bundledSrcRoot(), 'packages', 'cardo-skills', 'src', 'skills');
}

// ── dev test home ─────────────────────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

/** The user's real dsh home (~/.dsh). */
function realDshHome(): string {
  return path.join(homedir(), '.dsh');
}

/** The dev test home: a copy of ~/.dsh so dev runs never touch the real one. */
function devTestHome(): string {
  return path.join(app.getPath('userData'), 'dsh-test-home');
}

/** Sync ~/.dsh → dev test home (config only; node_modules excluded so the
 * copy stays small and fast). Called on dev startup so the test home tracks
 * the user's provider/plugin configuration edits. */
function syncDevTestHome(): void {
  const src = realDshHome();
  const dst = devTestHome();
  if (!existsSync(src)) {
    return; // no real home yet — nothing to mirror
  }
  mkdirSync(dst, { recursive: true });
  copyTree(src, dst, new Set());
}

function copyTree(src: string, dst: string, skipDirs: ReadonlySet<string>): void {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || skipDirs.has(entry.name)) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      copyTree(from, to, skipDirs);
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to);
    }
  }
}

let mainWindow: BrowserWindow | null = null;
let runtime: DshRuntimeHandle | null = null;
let restarts = 0;

// ── update check ──────────────────────────────────────────────────────────

const UPDATE_STATE_FILE = 'cardo-update-state.json';
const DEFAULT_API_BASE = 'https://api.github.com/repos/Uniterra-Solutions/cardo';
const DEFAULT_NPM_LATEST_URL = 'https://registry.npmjs.org/@uniterra-solutions/cardo/latest';
const DEFAULT_RELEASES_PAGE = 'https://github.com/Uniterra-Solutions/cardo/releases/latest';
const FETCH_TIMEOUT_MS = 10_000;
const CLI_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_STARTUP_DELAY_MS = 5_000;

function envOrDefault(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value !== undefined && value.length > 0 ? value : fallback;
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cardo-desktop' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, data: undefined };
    }
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    console.warn('[cardo] update check fetch failed:', error);
    return { ok: false, status: 0, data: undefined };
  }
}

function releaseVersionFromPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const tag = (payload as { tag_name?: unknown }).tag_name;
  if (typeof tag !== 'string') {
    return undefined;
  }
  const version = tag.replace(/^v/, '').trim();
  return version.length > 0 ? version : undefined;
}

async function fetchLatestReleaseVersion(): Promise<string | undefined> {
  const apiBase = envOrDefault('CARDO_UPDATE_API_BASE', DEFAULT_API_BASE);
  const latest = await fetchJson(`${apiBase}/releases/latest`);
  if (latest.ok) {
    const version = releaseVersionFromPayload(latest.data);
    if (version !== undefined) {
      return version;
    }
  }
  if (latest.status === 404) {
    const list = await fetchJson(`${apiBase}/releases?per_page=1`);
    if (!list.ok || !Array.isArray(list.data)) {
      return undefined;
    }
    return releaseVersionFromPayload(list.data[0]);
  }
  return undefined;
}

async function fetchLatestCliVersion(): Promise<string | undefined> {
  const outcome = await fetchJson(envOrDefault('CARDO_UPDATE_NPM_URL', DEFAULT_NPM_LATEST_URL));
  if (!outcome.ok || outcome.data === null || typeof outcome.data !== 'object') {
    return undefined;
  }
  const version = (outcome.data as { version?: unknown }).version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}

async function fetchInstalledCliVersion(): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    // `cardo` is the npm global bin; on Windows that is cardo.cmd, which
    // execFile cannot launch directly — shell: true lets cmd.exe resolve it
    // via PATHEXT (execFile's args are not shell-quoted; ours are fixed).
    const result = await execFileAsync('cardo', ['--version'], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const version = result.stdout.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function updateStatePath(): string {
  return path.join(app.getPath('userData'), UPDATE_STATE_FILE);
}

function readSkippedVersion(): string | undefined {
  try {
    const file = updateStatePath();
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { skippedVersion?: unknown };
    const skipped = parsed.skippedVersion;
    return typeof skipped === 'string' && skipped.length > 0 ? skipped : undefined;
  } catch {
    return undefined;
  }
}

function writeSkippedVersion(version: string): void {
  try {
    writeFileSync(updateStatePath(), `${JSON.stringify({ skippedVersion: version }, null, 2)}\n`);
  } catch (error) {
    console.warn('[cardo] failed to persist skipped version:', error);
  }
}

async function checkForCardoUpdate(): Promise<ReturnType<typeof resolveCardoUpdateStatus>> {
  const [latestReleaseVersion, latestCliVersion, cliVersion] = await Promise.all([
    fetchLatestReleaseVersion(),
    fetchLatestCliVersion(),
    fetchInstalledCliVersion(),
  ]);
  return resolveCardoUpdateStatus({
    appVersion: app.getVersion(),
    cliVersion,
    latestReleaseVersion,
    latestCliVersion,
  });
}

async function runCardoStartupUpdateCheck(): Promise<void> {
  const result = await checkForCardoUpdate();
  if (result.status === 'error' || result.status === 'up-to-date') {
    return;
  }
  const skippedVersion = readSkippedVersion();
  if (!shouldPromptForUpdate(result.latestVersion, skippedVersion)) {
    return;
  }
  const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await dialog.showMessageBox(parent ?? (undefined as never), {
    type: 'info',
    title: 'Cardo',
    message: `Cardo ${result.latestVersion} is available.`,
    detail: `You have ${result.currentVersion}. Update Now rebuilds and reinstalls the app from the latest source ('cardo setup') — it may take a few minutes. The CLI itself is updated separately with 'cardo update'.`,
    buttons: ['Update Now', 'Later', 'Skip This Version'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    // The desktop app is rebuilt from source; the CLI-only update lives in
    // `cardo update`. CARDO_UPDATE_COMMAND overrides the binary, args fixed.
    // (`cardo` is cardo.cmd on Windows — shell: true lets cmd.exe resolve it.)
    const command = envOrDefault('CARDO_UPDATE_COMMAND', 'cardo');
    const { spawn } = await import('node:child_process');
    const child = spawn(command, ['setup'], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.once('error', (error: Error) => {
      console.error('[cardo] failed to launch the installer:', error);
      void shell.openExternal(envOrDefault('CARDO_UPDATE_RELEASES_PAGE', DEFAULT_RELEASES_PAGE));
    });
    child.unref();
    app.quit();
  } else if (response === 2) {
    writeSkippedVersion(result.latestVersion);
  }
}

function initUpdateChecker(): () => void {
  const delay = Number.parseInt(process.env.CARDO_UPDATE_DELAY_MS ?? '', 10);
  const timeout = setTimeout(
    () => {
      void runCardoStartupUpdateCheck().catch((err: unknown) => {
        console.warn('[cardo] update check failed:', err);
      });
    },
    Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_STARTUP_DELAY_MS,
  );
  return () => {
    clearTimeout(timeout);
  };
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    title: 'Cardo',
    webPreferences: {
      // The dsh Web UI is a plain SPA on a loopback origin; it needs no
      // Node integration. Context isolation on keeps the renderer sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadURL(url);
  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

async function boot(): Promise<void> {
  // Cardo IS the dsh desktop surface: it runs against the user's dsh config.
  // Dev uses a mirrored test home (never touches the real ~/.dsh); the
  // packaged app uses the default DSH_HOME (~/.dsh) with the `web` profile.
  const dev = !app.isPackaged;
  const dshHome = dev ? devTestHome() : undefined;
  if (dev) {
    syncDevTestHome();
  }

  // Ensure the company built-ins are present in the profile this run uses.
  // The vendored plugins, the workspace built-ins, and the bundled skills all
  // come from the source tree the app was built from (dev: the monorepo;
  // packaged: Resources/src).
  const profile = 'web';
  const effectiveHome = dshHome ?? realDshHome();
  ensureBuiltinPlugins(
    effectiveHome,
    profile,
    dshCliPath(),
    process.execPath,
    vendorPluginsRoot(),
    bundledSrcRoot(),
  );

  // Bundled skills ride the DSH_BUNDLED_SKILL_DIR provider.
  const skills = skillsDir();

  initUpdateChecker();
  const handle = await startDsh({
    cli: dshCliPath(),
    nodeExec: process.execPath,
    ...(dshHome === undefined ? {} : { dshHome }),
    profile,
    ...(existsSync(skills) ? { dshBundledSkillDir: skills } : {}),
  });
  runtime = handle;
  restarts = 0;

  void handle.exited.then((code: number | null) => {
    void code;
    runtime = null;
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      // Runtime died under us: show a splash and restart with backoff.
      const backoff = Math.min(1000 * 2 ** restarts, 15_000);
      restarts += 1;
      setTimeout(() => {
        void boot().catch((err: unknown) => {
          console.error('cardo: dsh restart failed:', err);
        });
      }, backoff);
    }
  });

  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow(handle.url);
  } else {
    void mainWindow.loadURL(handle.url);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    void boot().catch((err: unknown) => {
      console.error('cardo: startup failed:', err);
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    // Quit on macOS too: closing the window ends the app (no dock-resident
    // background daemon) — the dsh runtime is only alive while the window is.
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (runtime !== null) {
      event.preventDefault();
      const handle = runtime;
      runtime = null;
      void stopDsh(handle.child).finally(() => {
        app.exit(0);
      });
    }
  });

  app.on('activate', () => {
    if (mainWindow === null && runtime !== null) {
      mainWindow = createWindow(runtime.url);
    }
  });
}
