/**
 * Cardo desktop main — Electron shell over a bundled DeepSeek Harness.
 *
 * Startup sequence:
 *   1. Single-instance lock (second launch focuses the existing window).
 *   2. Own DSH_HOME = the app's userData dir (never ~/.dsh).
 *   3. Scaffold the `cardo` profile (bundles + pinned plugins) on first run.
 *   4. Spawn the bundled dsh CLI (`node lib/bin.js --profile cardo`), wait
 *      for its readiness URL.
 *   5. Open a BrowserWindow on that URL; window close shuts dsh down.
 *   6. Crash-restart the runtime with a bounded backoff.
 */

import { app, BrowserWindow, dialog, shell } from 'electron';
import { createRequire } from 'node:module';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCardoProfile } from './profile.js';
import { startDsh, stopDsh, type DshRuntimeHandle } from './dsh-process.js';
import { resolveCardoUpdateStatus, shouldPromptForUpdate } from '@cardo/cardo-updater';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the bundled dsh CLI entry. In dev this is the workspace copy; in
 * the packaged app it is the asar-bundled dependency. */
function dshCliPath(): string {
  return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Where the vendored community plugins live at runtime. */
function vendorPluginsRoot(): string {
  // Packaged: resources/vendor/dsh-plugins. Dev: the monorepo checkout.
  const packaged = path.join(process.resourcesPath, 'vendor', 'dsh-plugins');
  if (pathExists(packaged)) {
    return packaged;
  }
  return path.resolve(here, '..', '..', '..', 'vendor', 'dsh-plugins');
}

let mainWindow: BrowserWindow | null = null;
let runtime: DshRuntimeHandle | null = null;
let restarts = 0;

// ── update check ──────────────────────────────────────────────────────────

const UPDATE_STATE_FILE = 'cardo-update-state.json';
const DEFAULT_API_BASE = 'https://api.github.com/repos/Uniterra-Solutions/cardo';
const DEFAULT_NPM_LATEST_URL = 'https://registry.npmjs.org/@cardo/cardo-cli/latest';
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
    const result = await execFileAsync('cardo', ['--version'], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const version = result.stdout.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function readSkippedVersion(dshHome: string): string | undefined {
  try {
    const file = path.join(dshHome, UPDATE_STATE_FILE);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { skippedVersion?: unknown };
    const skipped = parsed.skippedVersion;
    return typeof skipped === 'string' && skipped.length > 0 ? skipped : undefined;
  } catch {
    return undefined;
  }
}

function writeSkippedVersion(dshHome: string, version: string): void {
  try {
    writeFileSync(
      path.join(dshHome, UPDATE_STATE_FILE),
      `${JSON.stringify({ skippedVersion: version }, null, 2)}\n`,
    );
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

async function runCardoStartupUpdateCheck(dshHome: string): Promise<void> {
  const result = await checkForCardoUpdate();
  if (result.status === 'error' || result.status === 'up-to-date') {
    return;
  }
  const skippedVersion = readSkippedVersion(dshHome);
  if (!shouldPromptForUpdate(result.latestVersion, skippedVersion)) {
    return;
  }
  const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await dialog.showMessageBox(parent ?? (undefined as never), {
    type: 'info',
    title: 'Cardo',
    message: `Cardo ${result.latestVersion} is available.`,
    detail: `You have ${result.currentVersion}.`,
    buttons: ['Update Now', 'Later', 'Skip This Version'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    const command = envOrDefault('CARDO_UPDATE_COMMAND', 'cardo');
    const { spawn } = await import('node:child_process');
    const child = spawn(command, ['update'], { detached: true, stdio: 'ignore' });
    child.once('error', (error: Error) => {
      console.error('[cardo] failed to launch the updater:', error);
      void shell.openExternal(envOrDefault('CARDO_UPDATE_RELEASES_PAGE', DEFAULT_RELEASES_PAGE));
    });
    child.unref();
    app.quit();
  } else if (response === 2) {
    writeSkippedVersion(dshHome, result.latestVersion);
  }
}

function initUpdateChecker(dshHome: string): () => void {
  const delay = Number.parseInt(process.env.CARDO_UPDATE_DELAY_MS ?? '', 10);
  const timeout = setTimeout(
    () => {
      void runCardoStartupUpdateCheck(dshHome).catch((err: unknown) => {
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
  const dshHome = app.getPath('userData');
  ensureCardoProfile(dshHome, dshCliPath(), process.execPath, vendorPluginsRoot());
  initUpdateChecker(dshHome);

  const handle = await startDsh({
    cli: dshCliPath(),
    nodeExec: process.execPath,
    dshHome,
    profile: 'cardo',
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
