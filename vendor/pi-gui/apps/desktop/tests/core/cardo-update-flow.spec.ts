/**
 * Cardo e2e: the startup update-check flow.
 *
 * Feeds a local HTTP server with fake cardo release/npm responses, re-enables
 * the (otherwise harness-disabled) update check, stubs `dialog.showMessageBox`
 * via electronApp.evaluate, and triggers the check deterministically through
 * the `__PI_APP_TEST_HOOKS.runCardoUpdateCheck` hook.
 */
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  type DesktopHarness,
} from "../helpers/electron-app";

const UPDATE_STATE_FILE = "cardo-update-state.json";

interface MessageBoxCall {
  readonly message?: string;
  readonly detail?: string;
  readonly buttons?: readonly string[];
  readonly title?: string;
}

let server: Server;
let baseUrl = "";
let latestVersion = "9.9.9";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/releases/latest") {
      res.end(JSON.stringify({ tag_name: `v${latestVersion}` }));
      return;
    }
    if (url.pathname === "/releases" && url.searchParams.get("per_page") === "1") {
      res.end(JSON.stringify([{ tag_name: `v${latestVersion}` }]));
      return;
    }
    if (url.pathname === "/npm/latest") {
      res.end(JSON.stringify({ version: latestVersion }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("update-fixture server did not bind a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function launchWithUpdateEnabled(
  userDataDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<DesktopHarness> {
  return launchDesktop(userDataDir, {
    envOverrides: {
      CARDO_UPDATE_API_BASE: baseUrl,
      CARDO_UPDATE_NPM_URL: `${baseUrl}/npm/latest`,
      // Long delay so the automatic startup check never races the test; the
      // flow is triggered deterministically via the test hook below.
      CARDO_UPDATE_DELAY_MS: "60000",
      PI_APP_DISABLE_CARDO_UPDATE_CHECK: undefined,
      ...extraEnv,
    },
  });
}

async function stubMessageBox(
  harness: DesktopHarness,
  response: number,
): Promise<() => Promise<readonly MessageBoxCall[]>> {
  await harness.electronApp.evaluate(({ dialog }, canned) => {
    const globals = globalThis as { __PI_CARDO_MESSAGE_BOX_CALLS?: MessageBoxCall[] };
    globals.__PI_CARDO_MESSAGE_BOX_CALLS = [];
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as MessageBoxCall;
      globals.__PI_CARDO_MESSAGE_BOX_CALLS?.push(options);
      return { response: canned, checkboxChecked: false };
    };
  }, response);
  return async () =>
    harness.electronApp.evaluate(() => {
      return (
        (globalThis as { __PI_CARDO_MESSAGE_BOX_CALLS?: MessageBoxCall[] }).__PI_CARDO_MESSAGE_BOX_CALLS ?? []
      );
    });
}

async function triggerUpdateCheck(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(() => {
    const hooks = (globalThis as {
      __PI_APP_TEST_HOOKS?: { runCardoUpdateCheck?: () => Promise<void> };
    }).__PI_APP_TEST_HOOKS;
    if (!hooks?.runCardoUpdateCheck) {
      throw new Error("runCardoUpdateCheck test hook is unavailable");
    }
    return hooks.runCardoUpdateCheck();
  });
}

test("update available: Update Now spawns the updater and quits the app", async () => {
  latestVersion = "9.9.9";
  const tmp = await mkdtemp(join(tmpdir(), "cardo-update-e2e-"));
  const marker = join(tmp, "update-ran.txt");
  const fakeUpdater = join(tmp, "fake-cardo-update.sh");
  await writeFile(fakeUpdater, `#!/bin/sh\necho updated > "${marker}"\n`, "utf8");
  await chmod(fakeUpdater, 0o755);

  const userDataDir = await makeUserDataDir();
  const harness = await launchWithUpdateEnabled(userDataDir, {
    CARDO_UPDATE_COMMAND: fakeUpdater,
  });
  try {
    await harness.firstWindow();
    const getCalls = await stubMessageBox(harness, 0);
    await triggerUpdateCheck(harness);

    const calls = await getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain("9.9.9");
    expect(calls[0]?.buttons).toEqual(["Update Now", "Later", "Skip This Version"]);

    // The update action spawns the updater (detached) and quits the app.
    const appProcess = harness.electronApp.process();
    if (appProcess === null || appProcess === undefined) {
      throw new Error("electron app process is unavailable");
    }
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => appProcess.exitCode !== null, { timeout: 15_000 }).toBe(true);
  } finally {
    await harness.close().catch(() => undefined);
  }
});

test("update available: Skip persists the skipped version and suppresses the next prompt", async () => {
  latestVersion = "9.9.9";
  const userDataDir = await makeUserDataDir();
  const harness = await launchWithUpdateEnabled(userDataDir);
  try {
    await harness.firstWindow();
    const getCalls = await stubMessageBox(harness, 2);
    await triggerUpdateCheck(harness);

    expect(await getCalls()).toHaveLength(1);

    const stateFile = join(userDataDir, UPDATE_STATE_FILE);
    await expect
      .poll(async () => JSON.parse(await readFile(stateFile, "utf8")) as object, { timeout: 10_000 })
      .toEqual({ skippedVersion: "9.9.9" });

    // The same version was skipped — a fresh check must not prompt again.
    await triggerUpdateCheck(harness);
    expect(await getCalls()).toHaveLength(1);
  } finally {
    await harness.close().catch(() => undefined);
  }
});

test("update available: Later persists nothing and prompts again on the next check", async () => {
  latestVersion = "9.9.9";
  const userDataDir = await makeUserDataDir();
  const harness = await launchWithUpdateEnabled(userDataDir);
  try {
    await harness.firstWindow();
    const getCalls = await stubMessageBox(harness, 1);
    await triggerUpdateCheck(harness);
    expect(await getCalls()).toHaveLength(1);

    const stateFile = join(userDataDir, UPDATE_STATE_FILE);
    expect(existsSync(stateFile)).toBe(false);

    await triggerUpdateCheck(harness);
    expect(await getCalls()).toHaveLength(2);
  } finally {
    await harness.close().catch(() => undefined);
  }
});

test("no update: no prompt is shown when the latest release is not newer", async () => {
  latestVersion = "0.0.1";
  const userDataDir = await makeUserDataDir();
  const harness = await launchWithUpdateEnabled(userDataDir);
  try {
    await harness.firstWindow();
    const getCalls = await stubMessageBox(harness, 0);
    await triggerUpdateCheck(harness);
    // Give the check a moment to run its local fetches and CLI probe.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await getCalls()).toHaveLength(0);
  } finally {
    await harness.close().catch(() => undefined);
  }
});
