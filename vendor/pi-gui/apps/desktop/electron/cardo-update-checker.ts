/**
 * Cardo startup/manual update checking: probes the npm CLI dist-tag and the
 * cardo GitHub release, prompts the user when something newer exists, and
 * delegates the actual install to `cardo update`. Cardo-owned module — lives
 * alongside the vendored pi-gui update-checker (which is left untouched).
 */
import {
  app,
  dialog,
  net,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
} from "electron";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";
import { resolveCardoUpdateStatus, shouldPromptForUpdate } from "./cardo-update-logic";
import type { CardoUpdateResult } from "./cardo-update-logic";

const DEFAULT_API_BASE = "https://api.github.com/repos/Uniterra-Solutions/cardo";
const DEFAULT_NPM_LATEST_URL = "https://registry.npmjs.org/@uniterra-solutions/cardo/latest";
const DEFAULT_RELEASES_PAGE = "https://github.com/Uniterra-Solutions/cardo/releases/latest";
const FETCH_TIMEOUT_MS = 10_000;
const CLI_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_STARTUP_DELAY_MS = 5_000;
const UPDATE_STATE_FILE = "cardo-update-state.json";

export interface CardoUpdateCheckerOptions {
  readonly userDataDir: string;
  readonly getWindow: () => BrowserWindow | null | undefined;
}

export type CardoUpdatePromptChoice = "update" | "later" | "skip";

interface FetchOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly data: unknown;
}

interface CardoUpdateStateFile {
  readonly skippedVersion?: string;
}

let promptInFlight = false;
const execFileAsync = promisify(execFile);

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : fallback;
}

function envDelayMs(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

async function fetchJson(url: string): Promise<FetchOutcome> {
  try {
    const response = await net.fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "cardo-desktop" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, data: undefined };
    }
    return { ok: true, status: response.status, data: (await response.json()) as unknown };
  } catch (error) {
    console.warn(`[cardo] update check fetch failed (${url}):`, error);
    return { ok: false, status: 0, data: undefined };
  }
}

function releaseVersionFromPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const tag = (payload as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string") {
    return undefined;
  }
  const version = tag.replace(/^v/, "").trim();
  return version.length > 0 ? version : undefined;
}

async function fetchLatestReleaseVersion(): Promise<string | undefined> {
  const apiBase = envOrDefault("CARDO_UPDATE_API_BASE", DEFAULT_API_BASE);
  const latest = await fetchJson(`${apiBase}/releases/latest`);
  if (latest.ok) {
    const version = releaseVersionFromPayload(latest.data);
    if (version !== undefined) {
      return version;
    }
  }
  if (latest.status === 404) {
    // `/releases/latest` only returns non-prerelease releases; fall back to the
    // newest release (which may be a prerelease) so beta tags still update.
    const list = await fetchJson(`${apiBase}/releases?per_page=1`);
    if (!list.ok || !Array.isArray(list.data)) {
      return undefined;
    }
    return releaseVersionFromPayload(list.data[0]);
  }
  return undefined;
}

async function fetchLatestCliVersion(): Promise<string | undefined> {
  const outcome = await fetchJson(envOrDefault("CARDO_UPDATE_NPM_URL", DEFAULT_NPM_LATEST_URL));
  if (!outcome.ok || outcome.data === null || typeof outcome.data !== "object") {
    return undefined;
  }
  const version = (outcome.data as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : undefined;
}

async function fetchInstalledCliVersion(): Promise<string | undefined> {
  try {
    const result = await execFileAsync("cardo", ["--version"], {
      timeout: CLI_PROBE_TIMEOUT_MS,
      encoding: "utf8",
    });
    const version = String(result.stdout).trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

export async function checkForCardoUpdate(): Promise<CardoUpdateResult> {
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

async function readSkippedVersion(userDataDir: string): Promise<string | undefined> {
  const filePath = join(userDataDir, UPDATE_STATE_FILE);
  const result = await readJsonWithBackup<CardoUpdateStateFile>(filePath);
  const skipped = result.value?.skippedVersion;
  return typeof skipped === "string" && skipped.length > 0 ? skipped : undefined;
}

async function writeSkippedVersion(userDataDir: string, version: string): Promise<void> {
  const filePath = join(userDataDir, UPDATE_STATE_FILE);
  await writeFileAtomicQueued(filePath, `${JSON.stringify({ skippedVersion: version }, null, 2)}\n`);
}

function resolveDialogWindow(getWindow: CardoUpdateCheckerOptions["getWindow"]): BrowserWindow | undefined {
  const candidate = getWindow();
  return candidate !== null && candidate !== undefined && !candidate.isDestroyed() ? candidate : undefined;
}

async function showMessageBox(
  parentWindow: BrowserWindow | undefined,
  options: MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parentWindow !== undefined ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options);
}

export async function promptForCardoUpdate(
  options: CardoUpdateCheckerOptions,
  result: Extract<CardoUpdateResult, { status: "update-available" }>,
): Promise<CardoUpdatePromptChoice> {
  const window = resolveDialogWindow(options.getWindow);
  const { response } = await showMessageBox(window, {
    type: "info",
    title: "Cardo",
    message: `Cardo ${result.latestVersion} is available.`,
    detail: `You have ${result.currentVersion}.`,
    buttons: ["Update Now", "Later", "Skip This Version"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    return "update";
  }
  if (response === 2) {
    return "skip";
  }
  return "later";
}

function runCardoUpdateProcess(): void {
  const command = envOrDefault("CARDO_UPDATE_COMMAND", "cardo");
  const child = spawn(command, ["update"], { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    // e.g. ENOENT — no CLI installed; fall back to the GitHub releases page.
    console.error("[cardo] failed to launch the updater:", error);
    void shell.openExternal(envOrDefault("CARDO_UPDATE_RELEASES_PAGE", DEFAULT_RELEASES_PAGE)).catch(() => undefined);
  });
  child.unref();
}

function updateAndQuit(): void {
  runCardoUpdateProcess();
  app.quit();
}

export async function handleCardoUpdatePrompt(
  options: CardoUpdateCheckerOptions,
  result: Extract<CardoUpdateResult, { status: "update-available" }>,
  onRunUpdate: () => void,
): Promise<void> {
  const choice = await promptForCardoUpdate(options, result);
  if (choice === "update") {
    onRunUpdate();
    return;
  }
  if (choice === "skip") {
    await writeSkippedVersion(options.userDataDir, result.latestVersion);
  }
}

export async function runCardoStartupUpdateCheck(options: CardoUpdateCheckerOptions): Promise<void> {
  if (promptInFlight) {
    return;
  }
  promptInFlight = true;
  try {
    const result = await checkForCardoUpdate();
    if (result.status === "error") {
      console.warn("[cardo] update check failed:", result.message);
      return;
    }
    if (result.status === "up-to-date") {
      return;
    }
    const skippedVersion = await readSkippedVersion(options.userDataDir);
    if (!shouldPromptForUpdate(result.latestVersion, skippedVersion)) {
      return;
    }
    await handleCardoUpdatePrompt(options, result, updateAndQuit);
  } finally {
    promptInFlight = false;
  }
}

/** One-shot startup check after a short delay; returns the cleanup callback. */
export function initCardoUpdateChecker(options: CardoUpdateCheckerOptions): () => void {
  const delayMs = envDelayMs("CARDO_UPDATE_DELAY_MS", DEFAULT_STARTUP_DELAY_MS);
  const timeout = setTimeout(() => {
    void runCardoStartupUpdateCheck(options);
  }, delayMs);
  return () => clearTimeout(timeout);
}

export async function runManualCardoUpdateCheck(options: CardoUpdateCheckerOptions): Promise<void> {
  try {
    const result = await checkForCardoUpdate();
    const window = resolveDialogWindow(options.getWindow);
    if (result.status === "error") {
      await showMessageBox(window, {
        type: "warning",
        title: "Cardo",
        message: "Could not check for updates right now.",
        detail: result.message,
        buttons: ["OK"],
      });
      return;
    }
    if (result.status === "up-to-date") {
      await showMessageBox(window, {
        type: "info",
        title: "Cardo",
        message: `You're up to date on version ${result.currentVersion}.`,
        buttons: ["OK"],
      });
      return;
    }
    await handleCardoUpdatePrompt(options, result, updateAndQuit);
  } catch (error) {
    console.error("[cardo] manual update check failed:", error);
    const window = resolveDialogWindow(options.getWindow);
    await showMessageBox(window, {
      type: "warning",
      title: "Cardo",
      message: "Could not check for updates right now.",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    }).catch(() => undefined);
  }
}
