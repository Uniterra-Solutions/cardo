import { test } from "@playwright/test";
import {
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  resolvePackagedAppExecutable,
} from "../helpers/electron-app";
import { assertPackagedAppCanStartThread } from "./packaged-smoke-assertions";

test("launches the packaged app bundle and starts a thread through the real UI", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir("pi-gui-packaged-user-data-");
  const workspacePath = await makeWorkspace("packaged-smoke-workspace");
  const promptText = "Packaged smoke thread";
  const expectedExecutablePath = await resolvePackagedAppExecutable();
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await assertPackagedAppCanStartThread(harness, window, {
      expectedExecutablePath,
      promptText,
      workspacePath,
    });
  } finally {
    await harness.close();
  }
});
