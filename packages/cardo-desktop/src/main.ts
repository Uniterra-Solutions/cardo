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

import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCardoProfile } from './profile.js';
import { startDsh, stopDsh, type DshRuntimeHandle } from './dsh-process.js';

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
