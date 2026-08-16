import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createNamedThread,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from '../helpers/electron-app';

// Cardo: regression contract for the three-state Jovaltus mode toggle
// (standard | plan | debug), exercised against the real built-in jovaltus
// extension.
//
// 1. The composer mode button cycles standard -> plan -> debug -> standard;
//    the label and aria-pressed reflect the active mode.
// 2. Shift+tab in the composer cycles identically.
// 3. Every toggle runs as a runtime slash command (/planmode | /debugmode)
//    that must NOT paint a timeline row, and the jovaltus statuses must not
//    surface as a generic dock bar (FR-9 / FR-11).
test('mode toggle cycles standard -> plan -> debug -> standard, silently', async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace('jovaltus-mode-toggle-workspace');
  await initGitRepo(workspacePath);
  await mkdir(join(workspacePath, 'src'), { recursive: true });
  await writeFile(join(workspacePath, 'src', 'App.tsx'), 'export default function App() { return null; }\n', 'utf8');

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: 'background',
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, 'Mode toggle session');

    const modeButton = window.getByTestId('jovaltus-mode-button');
    await expect(modeButton).toBeVisible({ timeout: 15_000 });
    await expect(modeButton).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton).toContainText('standard');

    // The toggle handler is guarded: it only submits the mode command once the
    // jovaltus extension's commands are known to the runtime, so wait for both.
    await expect
      .poll(async () => {
        const nextState = await getDesktopState(window);
        const sessionKey = `${nextState.selectedWorkspaceId}:${nextState.selectedSessionId}`;
        return (nextState.sessionCommandsBySession[sessionKey] ?? []).map((command) => command.name).sort();
      })
      .toEqual(expect.arrayContaining(['planmode', 'debugmode']));

    const userMessages = window.locator('.timeline-item--user');
    const userMessageCount = await userMessages.count();
    const timeline = window.locator('.timeline');
    const dock = window.getByTestId('extension-dock');

    // The jovaltus mode status must not surface as a generic dock bar.
    await expect(dock).toHaveCount(0);

    // Cycle standard -> plan via the mode button.
    await modeButton.click();
    await expect(modeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton).toContainText('plan');
    await expect(userMessages).toHaveCount(userMessageCount);
    await expect(timeline).not.toContainText('/planmode');
    await expect(dock).toHaveCount(0);

    // Cycle plan -> debug.
    await modeButton.click();
    await expect(modeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton).toContainText('debug');
    await expect(timeline).not.toContainText('/debugmode');
    await expect(dock).toHaveCount(0);

    // Cycle debug -> standard.
    await modeButton.click();
    await expect(modeButton).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton).toContainText('standard');
    await expect(timeline).not.toContainText('/debugmode');
    await expect(dock).toHaveCount(0);

    // Shift+tab cycles identically (the handler prevents default, so focus
    // stays in the composer and the key can be pressed repeatedly).
    const composer = window.getByTestId('composer');
    await composer.focus();
    await window.keyboard.press('Shift+Tab');
    await expect(modeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton).toContainText('plan');
    await window.keyboard.press('Shift+Tab');
    await expect(modeButton).toContainText('debug');
    await window.keyboard.press('Shift+Tab');
    await expect(modeButton).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton).toContainText('standard');
    await expect(userMessages).toHaveCount(userMessageCount);
    await expect(timeline).not.toContainText('/planmode');
    await expect(timeline).not.toContainText('/debugmode');
    await expect(dock).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
