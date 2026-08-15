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

// Cardo: regression contract for selecting the Jovaltus plan mode on the
// NEW-THREAD page — the mode must be selectable before a conversation
// exists, not only inside an open thread.
//
// 1. The new-thread page shows a standard/plan mode picker (default standard).
// 2. Choosing plan and starting the thread runs /planmode before the first
//    message: the created thread's mode button reads plan mode immediately.
// 3. The /planmode command still runs silently — no "/planmode" message may
//    appear in the timeline.
test('new-thread page lets you pick plan mode before starting the conversation', async () => {
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

    // The mode picker is visible on the new-thread page, standard by default.
    const modeGroup = window.getByTestId('new-thread-mode');
    await expect(modeGroup).toBeVisible({ timeout: 15_000 });
    const standardOption = window.getByTestId('new-thread-mode-standard');
    const planOption = window.getByTestId('new-thread-mode-plan');
    await expect(standardOption).toHaveAttribute('aria-pressed', 'true');
    await expect(planOption).toHaveAttribute('aria-pressed', 'false');

    // Visual contract: the active option carries the accent tint background
    // (03b token set) and the labels are mono-uppercase chip text.
    await expect
      .poll(async () =>
        window
          .locator('.new-thread__mode-option--active')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe('rgba(0, 0, 0, 0)');

    // Select plan mode before the conversation exists.
    await planOption.click();
    await expect(standardOption).toHaveAttribute('aria-pressed', 'false');
    await expect(planOption).toHaveAttribute('aria-pressed', 'true');

    // Start the thread with a prompt.
    await window.getByLabel('New thread prompt').fill('Plan this feature');
    const startButton = window.getByRole('button', { name: 'Start thread' });
    await expect(startButton).toBeEnabled({ timeout: 15_000 });
    await startButton.click();

    // The new conversation is in plan mode from the start.
    const modeButton = window.getByTestId('jovaltus-mode-button');
    await expect(modeButton).toBeVisible({ timeout: 15_000 });
    await expect(modeButton).toHaveAttribute('aria-pressed', 'true');

    // The /planmode command ran silently: no timeline message for it.
    const timeline = window.locator('.timeline');
    await expect(timeline).not.toContainText('/planmode');
  } finally {
    await harness.close();
  }
});
