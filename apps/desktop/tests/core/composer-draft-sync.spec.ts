import { expect, test } from "@playwright/test";
import {
  clickSession,
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
} from "../helpers/electron-app";

test("ignores stale persisted draft acknowledgements while typing", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-draft-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Composer draft sync");

    const composer = window.getByTestId("composer");
    const expectedDraft = "forced-race-abcdef";
    const staleDraft = `${expectedDraft}x`;

    await composer.fill(staleDraft);
    await composer.press("Backspace");
    await expect(composer).toHaveValue(expectedDraft);

    await window.evaluate(({ stale }) => {
      window.setTimeout(() => {
        void window.piApp.updateComposerDraft(stale);
      }, 50);
    }, { stale: staleDraft });

    const sampledValues = await window.evaluate(async () => {
      const composer = document.querySelector<HTMLTextAreaElement>("[data-testid='composer']");
      if (!composer) {
        throw new Error("Composer textarea was unavailable");
      }

      const values: string[] = [];
      const started = performance.now();
      while (performance.now() - started < 900) {
        values.push(composer.value);
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      return values;
    });

    expect(sampledValues).not.toContain(staleDraft);
    await expect(composer).toHaveValue(expectedDraft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(expectedDraft);
  } finally {
    await harness.close();
  }
});

test("preserves a composer draft across a fast session switch", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-draft-fast-switch");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Draft Thread A");
    await createNamedThread(window, "Draft Thread B");

    await selectSession(window, "Draft Thread A");
    const composer = window.getByTestId("composer");
    const draft = "fast-switch-draft-xyz";
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);

    // Switch away immediately, before the 350ms persist debounce fires: the pending write must be
    // flushed onto Thread A rather than cancelled.
    await clickSession(window, "Draft Thread B");
    await expect(window.locator(".topbar__session")).toHaveText("Draft Thread B");

    await selectSession(window, "Draft Thread A");
    await expect(composer).toHaveValue(draft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
  } finally {
    await harness.close();
  }
});

test("applies explicit editor text replacements from the session host", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-editor-text-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Editor text sync");

    const composer = window.getByTestId("composer");
    await composer.fill("local draft");
    await expect(composer).toHaveValue("local draft");

    const state = await getDesktopState(window);
    await emitTestSessionEvent(harness, {
      type: "hostUiRequest",
      sessionRef: {
        workspaceId: state.selectedWorkspaceId,
        sessionId: state.selectedSessionId,
      },
      timestamp: new Date().toISOString(),
      request: {
        kind: "editorText",
        requestId: "editor-text-sync",
        text: "remote replacement",
      },
    });

    await expect(composer).toHaveValue("remote replacement");
  } finally {
    await harness.close();
  }
});
