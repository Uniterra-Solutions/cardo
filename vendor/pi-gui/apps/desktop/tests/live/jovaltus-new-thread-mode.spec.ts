import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from '../helpers/electron-app';

// Cardo: regression contract for the three-state Jovaltus mode picker on the
// NEW-THREAD page — the mode must be selectable before a conversation exists.
//
// 1. The picker shows standard/plan/debug (default standard).
// 2. Choosing debug and starting the thread runs /debugmode before the first
//    message: the created thread's mode button reads debug immediately.
// 3. The mode command runs silently — no '/debugmode' timeline row.
// 4. The picker resets to standard with the rest of the new-thread surface.
test('new-thread page lets you start a conversation in debug mode', async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace('jovaltus-new-thread-mode-workspace');
  await initGitRepo(workspacePath);
  await mkdir(join(workspacePath, 'src'), { recursive: true });
  await writeFile(
    join(workspacePath, 'src', 'App.tsx'),
    'export default function App() { return null; }\n',
    'utf8',
  );

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: 'background',
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);

    // The mode picker is visible on the new-thread page with all three
    // options, standard by default.
    const modeGroup = window.getByTestId('new-thread-mode');
    await expect(modeGroup).toBeVisible({ timeout: 15_000 });
    const standardOption = window.getByTestId('new-thread-mode-standard');
    const planOption = window.getByTestId('new-thread-mode-plan');
    const debugOption = window.getByTestId('new-thread-mode-debug');
    await expect(standardOption).toHaveAttribute('aria-pressed', 'true');
    await expect(planOption).toHaveAttribute('aria-pressed', 'false');
    await expect(debugOption).toHaveAttribute('aria-pressed', 'false');

    // Visual contract: the active option carries the accent tint background
    // (03b token set) and the labels are mono-uppercase chip text.
    await expect
      .poll(async () =>
        window
          .locator('.new-thread__mode-option--active')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe('rgba(0, 0, 0, 0)');

    // Select debug mode before the conversation exists.
    await debugOption.click();
    await expect(standardOption).toHaveAttribute('aria-pressed', 'false');
    await expect(debugOption).toHaveAttribute('aria-pressed', 'true');

    // Start the thread with a prompt.
    await window.getByLabel('New thread prompt').fill('Debug this bug');
    const startButton = window.getByRole('button', { name: 'Start thread' });
    await expect(startButton).toBeEnabled({ timeout: 15_000 });
    await startButton.click();

    // The new conversation is in debug mode from the start.
    const modeButton = window.getByTestId('jovaltus-mode-button');
    await expect(modeButton).toBeVisible({ timeout: 15_000 });
    await expect(modeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton).toContainText('debug');

    // The /debugmode command ran silently: no timeline message for it.
    const timeline = window.locator('.timeline');
    await expect(timeline).not.toContainText('/debugmode');

    // The new-thread surface resets: opening it again returns to standard.
    await openNewThread(window);
    await expect(standardOption).toHaveAttribute('aria-pressed', 'true');
    await expect(debugOption).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await harness.close();
  }
});
