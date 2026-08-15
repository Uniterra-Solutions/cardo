import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

// Cardo: regression contract for the plan-mode toggle UI, exercised against
// the real built-in jovaltus extension.
//
// 1. Toggling plan mode must NOT paint a "message sent to the agent" row:
//    /planmode is a runtime slash command that executes in the extension host
//    without a transcript message, so the composer submit path must not add
//    an optimistic user row.
// 2. The generic extension dock (chevron bar above the composer) must NOT
//    appear for the jovaltus statuses — the mode button and execute panel
//    already render them.
test("plan-mode toggle runs silently: button flips, no timeline message, no dock bar", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("jovaltus-mode-toggle-workspace");
  await initGitRepo(workspacePath);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "App.tsx"), "export default function App() { return null; }\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Plan mode toggle session");

    const modeButton = window.getByTestId("jovaltus-mode-button");
    await expect(modeButton).toBeVisible({ timeout: 15_000 });
    await expect(modeButton).toHaveAttribute("aria-pressed", "false");

    // The toggle handler is guarded: it only submits /planmode once the
    // jovaltus extension's command is known to the runtime, so wait for it.
    await expect
      .poll(async () => {
        const nextState = await getDesktopState(window);
        const sessionKey = `${nextState.selectedWorkspaceId}:${nextState.selectedSessionId}`;
        return (nextState.sessionCommandsBySession[sessionKey] ?? []).map((command) => command.name).sort();
      })
      .toEqual(expect.arrayContaining(["planmode"]));

    const userMessages = window.locator(".timeline-item--user");
    const userMessageCount = await userMessages.count();
    const timeline = window.locator(".timeline");
    const dock = window.getByTestId("extension-dock");

    // The jovaltus mode status must not surface as a generic dock bar.
    await expect(dock).toHaveCount(0);

    // Toggle ON via the mode button.
    await modeButton.click();
    await expect(modeButton).toHaveAttribute("aria-pressed", "true");

    // The toggle must not show up as a message sent to the agent…
    await expect(userMessages).toHaveCount(userMessageCount);
    await expect(timeline).not.toContainText("/planmode");
    // …and the dock bar must stay hidden.
    await expect(dock).toHaveCount(0);

    // Toggle OFF via shift+tab in the composer (same handler as the button).
    const composer = window.getByTestId("composer");
    await composer.focus();
    await window.keyboard.press("Shift+Tab");
    await expect(modeButton).toHaveAttribute("aria-pressed", "false");
    await expect(userMessages).toHaveCount(userMessageCount);
    await expect(timeline).not.toContainText("/planmode");
    await expect(dock).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
