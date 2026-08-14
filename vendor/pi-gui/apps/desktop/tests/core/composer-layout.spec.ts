import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("composer single-row layout: attach | textarea | selects | send on one line; scrollbars are thin and semi-transparent", async () => {
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
      const textarea = document.querySelector(".composer textarea");
      const badge = document.querySelector(".model-selector__badge");
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
        textareaRect: rect(textarea),
        badgeRect: rect(badge),
        sendRect: rect(send),
        borderTopWidth: surfaceStyle?.borderTopWidth,
        borderTopColor: surfaceStyle?.borderTopColor,
        boxShadow: surfaceStyle?.boxShadow,
      };
    });
    console.log("CHAT-LAYOUT: " + JSON.stringify(chatLayout));
    const s = chatLayout.surfaceRect!;
    const centerY = (r: { readonly top: number; readonly bottom: number } | null) =>
      r ? (r.top + r.bottom) / 2 : 0;
    expect(chatLayout.attachRect!.left).toBeGreaterThanOrEqual(s.left);
    expect(chatLayout.textareaRect!.left).toBeGreaterThan(chatLayout.attachRect!.right);
    expect(chatLayout.badgeRect!.left).toBeGreaterThan(chatLayout.textareaRect!.right);
    expect(chatLayout.sendRect!.left).toBeGreaterThan(chatLayout.badgeRect!.right);
    expect(chatLayout.sendRect!.right).toBeLessThanOrEqual(s.right + 1);
    expect(chatLayout.sendRect!.bottom).toBeLessThanOrEqual(s.bottom + 1);
    expect(Math.abs(centerY(chatLayout.textareaRect) - centerY(chatLayout.sendRect))).toBeLessThan(1);
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
      const textarea = document.querySelector(".composer textarea");
      const envSelect = document.querySelector(".new-thread__environment-select");
      const badge = document.querySelector(".model-selector__badge");
      const send = document.querySelector(".button--cta-icon");
      const rect = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      };
      const surfaceRect = rect(surface);
      return {
        surfaceRect,
        attachRect: rect(attach),
        textareaRect: rect(textarea),
        envSelectRect: rect(envSelect),
        badgeRect: rect(badge),
        sendRect: rect(send),
        envTagName: envSelect?.tagName,
        envValue: (envSelect as HTMLSelectElement | null)?.value,
        surfaceBorderTopWidth: surface ? getComputedStyle(surface).borderTopWidth : null,
      };
    });
    console.log("NT-LAYOUT: " + JSON.stringify(ntLayout));
    expect(ntLayout.envTagName).toBe("SELECT");
    expect(ntLayout.envValue).toBe("local");
    expect(ntLayout.attachRect!.left).toBeGreaterThanOrEqual(ntLayout.surfaceRect!.left);
    expect(ntLayout.textareaRect!.left).toBeGreaterThan(ntLayout.attachRect!.right);
    expect(ntLayout.envSelectRect!.left).toBeGreaterThan(ntLayout.textareaRect!.right);
    expect(ntLayout.sendRect!.left).toBeGreaterThan(ntLayout.badgeRect!.right);
    expect(ntLayout.sendRect!.right).toBeLessThanOrEqual(ntLayout.surfaceRect!.right + 1);
    expect(ntLayout.sendRect!.bottom).toBeLessThanOrEqual(ntLayout.surfaceRect!.bottom + 1);

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
