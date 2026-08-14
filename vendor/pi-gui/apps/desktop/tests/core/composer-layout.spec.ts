import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("composer footer layout: attach left, selects center, send right; scrollbars are thin and semi-transparent", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("tmp-verify");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window.waitForTimeout(1000);

    // chat composer: create a thread first
    await createNamedThread(window, "Verify layout");
    await window.getByTestId("composer").fill("hello");
    await window.waitForTimeout(600);

    const chatLayout = await window.evaluate(() => {
      const surface = document.querySelector(".composer__surface");
      const attach = document.querySelector(".composer__attach");
      const hint = document.querySelector(".composer__hint");
      const send = document.querySelector('[data-testid="send"]');
      const rect = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      };
      const surfaceRect = rect(surface);
      const surfaceStyle = surface ? getComputedStyle(surface) : null;
      return {
        surfaceRect,
        attachRect: rect(attach),
        hintRect: rect(hint),
        sendRect: rect(send),
        borderTopWidth: surfaceStyle?.borderTopWidth,
        borderTopColor: surfaceStyle?.borderTopColor,
        boxShadow: surfaceStyle?.boxShadow,
      };
    });
    console.log("CHAT-LAYOUT: " + JSON.stringify(chatLayout));
    const s = chatLayout.surfaceRect!;
    expect(chatLayout.attachRect!.left).toBeGreaterThanOrEqual(s.left);
    expect(chatLayout.hintRect!.left).toBeGreaterThan(chatLayout.attachRect!.right);
    expect(chatLayout.sendRect!.left).toBeGreaterThan(chatLayout.hintRect!.right);
    expect(chatLayout.sendRect!.right).toBeLessThanOrEqual(s.right + 1);
    expect(chatLayout.sendRect!.bottom).toBeLessThanOrEqual(s.bottom + 1);
    expect(chatLayout.borderTopWidth).toBe("1px");

    const scrollbarInfo = await window.evaluate(() => {
      const rules: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let sheetRules: CSSRule[];
        try {
          sheetRules = Array.from(sheet.cssRules);
        } catch {
          continue;
        }
        for (const rule of sheetRules) {
          if (rule instanceof CSSStyleRule && rule.selectorText.includes("scrollbar")) {
            rules.push(`${rule.selectorText} { ${rule.style.cssText} }`);
          }
        }
      }
      const sample = document.querySelector(".composer__editor");
      const cs = sample ? getComputedStyle(sample) : null;
      return { rules, scrollbarWidth: cs?.scrollbarWidth };
    });
    console.log("SCROLLBAR-RULES: " + JSON.stringify(scrollbarInfo.rules));
    expect(scrollbarInfo.rules.some((r) => r.includes("::-webkit-scrollbar {"))).toBe(true);
    expect(scrollbarInfo.rules.some((r) => r.includes("width: 7px"))).toBe(true);
    expect(scrollbarInfo.scrollbarWidth).toBe("thin");

    // new-thread composer
    await window.keyboard.press(desktopShortcut("Shift+O"));
    await window.getByTestId("new-thread-composer").waitFor();
    await window.waitForTimeout(500);
    const ntLayout = await window.evaluate(() => {
      const surface = document.querySelector(".composer__surface");
      const attach = document.querySelector(".composer__attach");
      const hint = document.querySelector(".new-thread__hint");
      const send = document.querySelector(".composer__footer-row .button--cta-icon");
      const envSelect = document.querySelector(".new-thread__environment-select");
      const rect = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      };
      const surfaceRect = rect(surface);
      return {
        surfaceRect,
        attachRect: rect(attach),
        hintRect: rect(hint),
        sendRect: rect(send),
        envSelectRect: rect(envSelect),
        envTagName: envSelect?.tagName,
        envValue: (envSelect as HTMLSelectElement | null)?.value,
        hintContainsSelector: Boolean(hint?.querySelector(".model-selector__badge")),
        surfaceBorderTopWidth: surface ? getComputedStyle(surface).borderTopWidth : null,
      };
    });
    console.log("NT-LAYOUT: " + JSON.stringify(ntLayout));
    expect(ntLayout.envTagName).toBe("SELECT");
    expect(ntLayout.envValue).toBe("local");
    expect(ntLayout.hintContainsSelector).toBe(true);
    expect(ntLayout.attachRect!.left).toBeGreaterThanOrEqual(ntLayout.surfaceRect!.left);
    expect(ntLayout.sendRect!.right).toBeLessThanOrEqual(ntLayout.surfaceRect!.right + 1);
    expect(ntLayout.envSelectRect!.left).toBeGreaterThan(ntLayout.attachRect!.right);
    expect(ntLayout.sendRect!.left).toBeGreaterThan(ntLayout.envSelectRect!.right);

    await window.locator(".new-thread__environment-select").selectOption("worktree");
    const newValue = await window
      .locator(".new-thread__environment-select")
      .evaluate((el) => (el as HTMLSelectElement).value);
    expect(newValue).toBe("worktree");
  } finally {
    await harness.close();
  }
});

test("composer surface keeps 1px theme border without the focus ring layer", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("tmp-verify-dark");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_APP_THEME_MODE: "dark" },
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Verify dark");
    await window.getByTestId("composer").fill("hello");
    await window.waitForTimeout(500);
    const info = await window.evaluate(() => {
      const surface = document.querySelector(".composer__surface")!;
      const cs = getComputedStyle(surface);
      return { boxShadow: cs.boxShadow, borderTopWidth: cs.borderTopWidth, borderTopColor: cs.borderTopColor };
    });
    console.log("DARK-SURFACE: " + JSON.stringify(info));
    expect(info.borderTopWidth).toBe("1px");
    expect(info.boxShadow.startsWith("rgba(0, 0, 0, 0) 0px 0px 0px 1px")).toBe(false);
  } finally {
    await harness.close();
  }
});
