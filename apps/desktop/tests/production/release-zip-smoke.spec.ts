import { test } from "@playwright/test";
import {
  extractPackagedReleaseZipAppBundle,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolveAppBundleExecutable,
} from "../helpers/electron-app";
import { assertPackagedAppCanStartThread } from "./packaged-smoke-assertions";

test("launches the packaged release zip app bundle from an extracted download path and starts a thread", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir("pi-gui-release-zip-user-data-");
  const workspacePath = await makeWorkspace("release-zip-smoke-workspace");
  const promptText = "Release zip smoke thread";
  const appBundlePath = await extractPackagedReleaseZipAppBundle();
  const expectedExecutablePath = await resolveAppBundleExecutable(appBundlePath);
  const harness = await launchDesktopByExecutable(expectedExecutablePath, userDataDir, {
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
