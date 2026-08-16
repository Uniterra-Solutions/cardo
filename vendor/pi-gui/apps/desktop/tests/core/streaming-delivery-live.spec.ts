import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

/**
 * Bounded live self-verification for the state snapshot + delta delivery
 * refactor (acceptance.md §4). The full-snapshot path delivers the initial
 * state; afterwards the state-delta channel keeps the pushed state current
 * while a message lands (revision advances, the sidebar session preview
 * updates), the transcript-delta channel stays intact, and a sidebar toggle
 * round-trips through IPC without stalling — the original bug symptom.
 */
test("state-delta delivery keeps the pushed state current and IPC responsive", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("stream-live");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Stream live");

    // Full snapshot path delivered on launch: a selected session with a bumped
    // revision (createNamedThread opens + selects the session).
    const initial = await getDesktopState(window);
    expect(initial.selectedSessionId).toBeTruthy();
    expect(initial.revision).toBeGreaterThan(0);
    const initialWorkspace = initial.workspaces.find((entry) => entry.id === initial.selectedWorkspaceId);
    const initialSession = initialWorkspace?.sessions.find((entry) => entry.id === initial.selectedSessionId);
    const initialPreview = initialSession?.preview ?? "";

    // Submit a message through the composer; the pushed state must keep
    // advancing (revision strictly increases) and the renderer must apply the
    // new session state (the sidebar preview changes from what it was before
    // the submit — the offline harness run fails fast, so the exact preview
    // text is environment-dependent; only the change is deterministic).
    const submittedText = "stream-delivery-live-check";
    const composer = window.getByTestId("composer");
    await composer.fill(submittedText);
    await composer.press("Enter");

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
          const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
          return state.revision > initial.revision && Boolean(session?.preview && session.preview !== initialPreview);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // The renderer applied the pushed state: the sidebar session preview
    // (driven by the hook's snapshot via the state-delta path) is no longer
    // the pre-submit text — the offline harness run fails fast, so the exact
    // new text is environment-dependent; only the change is deterministic.
    await expect
      .poll(
        async () => {
          const preview = await window.locator(".session-row__preview").first().textContent();
          return Boolean(preview && preview !== initialPreview);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    // ...and the transcript (transcript-delta channel) contains it too.
    await expect(window.getByTestId("transcript")).toContainText(submittedText, {
      timeout: 30_000,
    });

    // A sidebar toggle round-trips through IPC: the sidebar collapses in the
    // DOM AND the main process reports sidebarCollapsed: true — proving the
    // IPC publish lane is not stalled.
    await window.getByTestId("sidebar-toggle").click();
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect.poll(async () => (await getDesktopState(window)).sidebarCollapsed).toBe(true);
  } finally {
    await harness.close();
  }
});
