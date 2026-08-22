/**
 * Uniterra desktop main — Electron shell over DeepSeek Harness.
 *
 * Uniterra IS the dsh desktop surface: it runs the bundled dsh CLI against the
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

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDsh, stopDsh, type DshRuntimeHandle } from './dsh-process.js';
import { ensureBuiltinPlugins } from './builtin.js';
import {
  initialOverlayState,
  resolveUniterraUpdateStatus,
  resolveUpdateAction,
  shouldPromptForUpdate,
  updateInvocation,
  type OverlayState,
} from '@uniterra-solutions/uniterra-updater';
import { startOverlayUpdate } from './update-overlay.js';
import { UPDATE_OVERLAY_HTML, UPDATE_OVERLAY_PRELOAD } from './update-overlay-ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bundled source tree the app was built from. `uniterra setup` embeds the
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
 * workspace `@deepseek-ai/dsh` is a devDependency of the uniterra-desktop
 * package, so pnpm links it under `packages/uniterra-desktop/node_modules`
 * (never the workspace root). Dev and packaged both resolve it there — with
 * one Windows exception: the installer embeds the tree with robocopy, which
 * MATERIALIZES pnpm's junctions (directory links become real copies), so the
 * junction path cannot resolve dsh's own dependencies (ERR_MODULE_NOT_FOUND
 * on boot). Windows resolves the package's physical .pnpm store location
 * instead, where every dependency is a materialized sibling. */
function dshCliPath(): string {
  const junctionPath = path.join(
    bundledSrcRoot(),
    'packages',
    'uniterra-desktop',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  if (process.platform !== 'win32') {
    return junctionPath;
  }
  const storeRoot = path.join(bundledSrcRoot(), 'node_modules', '.pnpm');
  let storeBin: string | undefined;
  try {
    storeBin = readdirSync(storeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('@deepseek-ai+dsh@'))
      .map((entry) =>
        path.join(storeRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      )
      .find((candidate) => existsSync(candidate));
  } catch {
    storeBin = undefined; // no .pnpm store — fall back to the junction path
  }
  return storeBin ?? junctionPath;
}

/** Vendored (non-npm) plugin sources inside the source tree. */
function vendorPluginsRoot(): string {
  return path.join(bundledSrcRoot(), 'vendor', 'dsh-plugins');
}

/** Bundled company skills inside the source tree. */
function skillsDir(): string {
  return path.join(bundledSrcRoot(), 'packages', 'uniterra-skills', 'src', 'skills');
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
// The in-app update overlay (issue #15, macOS): the window itself, the
// current overlay phase (drives the close/quit guard), and the target version
// for retries. updateOverlayState is null when no update flow is running.
let updateOverlayWindow: BrowserWindow | null = null;
let updateOverlayState: OverlayState | null = null;
let updateTargetVersion: string | undefined;

// ── update check ──────────────────────────────────────────────────────────

const UPDATE_STATE_FILE = 'uniterra-update-state.json';
const DEFAULT_API_BASE = 'https://api.github.com/repos/Uniterra-Solutions/uniterra';
const DEFAULT_NPM_LATEST_URL = 'https://registry.npmjs.org/@uniterra-solutions/uniterra/latest';
const DEFAULT_RELEASES_PAGE = 'https://github.com/Uniterra-Solutions/uniterra/releases/latest';
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
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'uniterra-desktop' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, data: undefined };
    }
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    console.warn('[uniterra] update check fetch failed:', error);
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
  const apiBase = envOrDefault('UNITERRA_UPDATE_API_BASE', DEFAULT_API_BASE);
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
  const outcome = await fetchJson(envOrDefault('UNITERRA_UPDATE_NPM_URL', DEFAULT_NPM_LATEST_URL));
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
    // `uniterra` is the npm global bin; on Windows that is uniterra.cmd, which
    // execFile cannot launch directly — shell: true lets cmd.exe resolve it
    // via PATHEXT (execFile's args are not shell-quoted; ours are fixed).
    const result = await execFileAsync('uniterra', ['--version'], {
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
    console.warn('[uniterra] failed to persist skipped version:', error);
  }
}

async function checkForUniterraUpdate(): Promise<ReturnType<typeof resolveUniterraUpdateStatus>> {
  const [latestReleaseVersion, latestCliVersion, cliVersion] = await Promise.all([
    fetchLatestReleaseVersion(),
    fetchLatestCliVersion(),
    fetchInstalledCliVersion(),
  ]);
  return resolveUniterraUpdateStatus({
    appVersion: app.getVersion(),
    cliVersion,
    latestReleaseVersion,
    latestCliVersion,
  });
}

async function runUniterraStartupUpdateCheck(): Promise<void> {
  const result = await checkForUniterraUpdate();
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
    title: 'Uniterra',
    message: `Uniterra ${result.latestVersion} is available.`,
    detail:
      process.platform === 'darwin'
        ? `You have ${result.currentVersion}. Update Now runs 'uniterra update' in the background with a progress overlay and restarts Uniterra when done — it may take a few minutes. Do not close the application during the update.`
        : `You have ${result.currentVersion}. Update Now closes Uniterra and runs 'uniterra update', which updates the CLI, rebuilds + reinstalls the app from the latest source, and restarts the app when done — it may take a few minutes.`,
    buttons: ['Update Now', 'Later', 'Skip This Version'],
    defaultId: 0,
    cancelId: 1,
  });
  const action = resolveUpdateAction(result, response);
  if (action.action === 'quit-and-update') {
    // resolveUpdateAction only returns 'quit-and-update' for an available
    // update, so result.status is narrowed to 'update-available' here and
    // latestVersion is guaranteed present.
    if (process.platform === 'darwin') {
      // FR-15.1–15.6 (macOS): keep the app alive and run the updater as a
      // CHILD PROCESS (`uniterra update --no-open`), streaming its output
      // into the in-app overlay; the app relaunches itself on success. The
      // macOS bundle can be replaced in place (POSIX unlink of a running
      // bundle); Windows keeps the quit-first detached flow below because
      // %LOCALAPPDATA% is the directory the running app executes from and
      // cannot be replaced in place (FR-15.4).
      runOverlayUpdate(result.latestVersion);
      return;
    }
    // `uniterra update` is the single full-update command (CLI refresh + app
    // rebuild + relaunch). It is spawned detached BEFORE quitting so it
    // survives the app shutdown, and it relaunches the app when done —
    // that relaunch IS the restart. The default invocation runs the LATEST
    // updater via npx (`npx --yes @uniterra-solutions/uniterra@latest update`)
    // so a stale global uniterra CLI can never do a CLI-only update and leave
    // the app closed; UNITERRA_UPDATE_COMMAND overrides the command. (npm
    // shims are `.cmd` on Windows — shell: true lets cmd.exe resolve them.)
    const invocation = updateInvocation(process.env.UNITERRA_UPDATE_COMMAND);
    const { spawn } = await import('node:child_process');
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.once('error', (error: Error) => {
      console.error('[uniterra] failed to launch the updater:', error);
      void shell.openExternal(envOrDefault('UNITERRA_UPDATE_RELEASES_PAGE', DEFAULT_RELEASES_PAGE));
    });
    child.unref();
    app.quit();
  } else if (action.action === 'skip-version') {
    writeSkippedVersion(action.skippedVersion);
  }
}

// ── in-app update overlay (issue #15, macOS) ─────────────────────────────

/** Whether an update is running — window closes and app quits are blocked
 * until it finishes (the close does nothing during the run, FR-15.6). */
function updateInProgress(): boolean {
  return (
    updateOverlayState !== null &&
    (updateOverlayState.phase === 'init' || updateOverlayState.phase === 'running')
  );
}

/** Block window close while the update runs — closing mid-copy could kill a
 * running install; the close is ignored until the update finishes. */
function guardUpdateClose(event: Electron.Event): void {
  if (updateInProgress()) {
    event.preventDefault();
  }
}

/** Electron requires a file path for webPreferences.preload, so the embedded
 * preload source is written to userData (always overwritten; static content). */
function writeUpdateOverlayPreload(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const preloadPath = path.join(dir, 'update-overlay-preload.cjs');
  writeFileSync(preloadPath, UPDATE_OVERLAY_PRELOAD);
  return preloadPath;
}

/** The dedicated overlay window: a small modal over the main window showing a
 * spinner + stage label during the run, the success copy on completion, and
 * retry / open-releases / dismiss buttons on failure. */
function createUpdateOverlayWindow(): BrowserWindow {
  const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const win = new BrowserWindow({
    width: 440,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Updating Uniterra',
    show: false,
    ...(parent === undefined ? {} : { parent, modal: true }),
    webPreferences: {
      preload: writeUpdateOverlayPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateOverlayWindow = win;
  win.on('close', guardUpdateClose);
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    if (updateOverlayWindow === win) {
      updateOverlayWindow = null;
    }
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(UPDATE_OVERLAY_HTML)}`);
  return win;
}

/** FR-15.1–15.6 (macOS): start (or retry) the overlay update flow for the
 * given target version. The child is only spawned once the overlay page has
 * loaded so no state push is lost; a retry reuses the loaded window and the
 * updater reinstalls from scratch. */
function runOverlayUpdate(version: string): void {
  updateTargetVersion = version;
  updateOverlayState = initialOverlayState;
  const window =
    updateOverlayWindow !== null && !updateOverlayWindow.isDestroyed()
      ? updateOverlayWindow
      : createUpdateOverlayWindow();
  const start = (): void => {
    if (window.isDestroyed()) {
      return;
    }
    startOverlayUpdate({
      invocation: updateInvocation(process.env.UNITERRA_UPDATE_COMMAND, { noOpen: true }),
      version,
      callbacks: {
        onState: (state) => {
          updateOverlayState = state;
          if (!window.isDestroyed()) {
            window.webContents.send('update:status', state);
          }
        },
        onSuccess: () => {
          // FR-15.5: relaunch immediately — no await between relaunch and
          // quit. The before-quit handler still stops dsh before app.exit(0);
          // if a stale instance still holds the single-instance lock, its
          // second-instance handler restores focus to the fresh instance.
          app.relaunch();
          app.quit();
        },
      },
    });
  };
  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', start);
  } else {
    start();
  }
}

function initUpdateChecker(): () => void {
  const delay = Number.parseInt(process.env.UNITERRA_UPDATE_DELAY_MS ?? '', 10);
  const timeout = setTimeout(
    () => {
      void runUniterraStartupUpdateCheck().catch((err: unknown) => {
        console.warn('[uniterra] update check failed:', err);
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
    title: 'Uniterra',
    webPreferences: {
      // The dsh Web UI is a plain SPA on a loopback origin; it needs no
      // Node integration. Context isolation on keeps the renderer sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadURL(url);
  // Closing the main window mid-update would quit the app and kill the
  // running install — the close is ignored while the update runs (FR-15.6).
  win.on('close', guardUpdateClose);
  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

/** The packaged app surfaces startup failures only to stderr, which no one
 * sees — the reported symptom was a ~60 s hang then a silent exit. Write the
 * failure (including the dsh child's captured stderr, which {@link startDsh}
 * already folds into the error message) to a log under userData, and on the
 * first boot also raise a native dialog so a broken install is diagnosable. */
function startupLogPath(): string {
  return path.join(app.getPath('userData'), 'startup-error.log');
}

function reportStartupFailure(err: unknown, showDialog: boolean): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const logPath = startupLogPath();
  try {
    // On a broken first boot the userData dir may not exist yet — ensure it so
    // the primary diagnostic artifact is never lost to ENOENT.
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${detail}\n\n`);
  } catch (writeErr) {
    console.error('uniterra: failed to write the startup log:', writeErr);
  }
  console.error('uniterra: startup failed:', err);
  if (showDialog) {
    dialog.showErrorBox(
      'Uniterra failed to start',
      `${detail}\n\nA log was written to:\n${logPath}`,
    );
  }
}

async function boot(): Promise<void> {
  // Uniterra IS the dsh desktop surface: it runs against the user's dsh config.
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
          reportStartupFailure(err, false);
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
      reportStartupFailure(err, true);
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    // Quit on macOS too: closing the window ends the app (no dock-resident
    // background daemon) — the dsh runtime is only alive while the window is.
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (updateInProgress()) {
      event.preventDefault();
      return;
    }
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

  // In-app overlay actions (issue #15): the overlay window's buttons.
  ipcMain.on('update:retry', () => {
    if (updateTargetVersion !== undefined && updateOverlayState?.phase === 'failure') {
      runOverlayUpdate(updateTargetVersion);
    }
  });
  ipcMain.on('update:dismiss', () => {
    if (updateOverlayWindow !== null && !updateOverlayWindow.isDestroyed()) {
      updateOverlayWindow.close();
    }
  });
  ipcMain.on('update:open-releases', () => {
    void shell.openExternal(envOrDefault('UNITERRA_UPDATE_RELEASES_PAGE', DEFAULT_RELEASES_PAGE));
  });
}
