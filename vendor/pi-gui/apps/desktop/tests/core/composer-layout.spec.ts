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
    // Cardo: borderless composer shell (review feedback).
    expect(chatLayout.borderTopWidth).toBe("0px");

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

test("composer surface is borderless (no border, no focus ring layer)", async () => {
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
      const textarea = document.querySelector(".composer textarea")!;
      const scs = getComputedStyle(surface);
      const tcs = getComputedStyle(textarea);
      return {
        boxShadow: scs.boxShadow,
        borderTopWidth: scs.borderTopWidth,
        borderTopColor: scs.borderTopColor,
        textareaBoxShadow: tcs.boxShadow,
      };
    });
    console.log("DARK-SURFACE: " + JSON.stringify(info));
    // Cardo: borderless composer shell (review feedback) — no border, no
    // accent focus ring on the textarea either.
    expect(info.borderTopWidth).toBe("0px");
    expect(info.textareaBoxShadow).toBe("none");
    expect(info.boxShadow.startsWith("rgba(0, 0, 0, 0) 0px 0px 0px 1px")).toBe(false);
  } finally {
    await harness.close();
  }
});

test("wrapped composer keeps the controls flush right (no shift from the plan-mode button)", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("tmp-verify-wrap");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Verify wrap");
    const composer = window.getByTestId("composer");
    // A long prompt wraps the composer: textarea on the full first row,
    // attach left + trailing controls right on the bottom row.
    await composer.fill(
      "Explain the cardo monorepo layout and how the Jovaltus plan-mode gating interacts with the execute widget protocol inside the desktop app, including the SQLite session store and the streaming delivery path",
    );
    await window.waitForTimeout(1200);

    const layout = await window.evaluate(() => {
      const surface = document.querySelector(".composer__surface")!;
      const row = document.querySelector(".composer__editor-row")!;
      const children = Array.from(row.children);
      const textarea = row.querySelector("textarea")!;
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      };
      const surfaceRect = rect(surface);
      const textareaRect = rect(textarea);
      // Trailing controls: everything after the textarea (model selector,
      // send button, plan-mode button when present).
      const trailing = children.filter((child) => child !== textarea && child !== children[0]);
      const trailingRects = trailing.map((el) => ({ cls: (el.className ?? "").toString().slice(0, 60), rect: rect(el) }));
      const rowTop = surfaceRect.top;
      const bottomRowTop = Math.max(...trailingRects.map((t) => t.rect.top));
      const rightmost = trailingRects.reduce(
        (max, t) => (t.rect.right > max.rect.right ? t : max),
        { cls: "", rect: { left: 0, right: 0, top: 0, bottom: 0, width: 0 } },
      );
      // Gap between consecutive trailing controls must be small (no auto-margin
      // split between the send button and the plan-mode button).
      const sorted = [...trailingRects].sort((a, b) => a.rect.left - b.rect.left);
      let maxGap = 0;
      for (let i = 1; i < sorted.length; i += 1) {
        maxGap = Math.max(maxGap, sorted[i].rect.left - sorted[i - 1].rect.right);
      }
      return {
        wrapped: surface.classList.contains("composer__surface--wrapped"),
        textareaFullWidth: textareaRect.width > surfaceRect.width * 0.8,
        textareaOnTopRow: textareaRect.top < bottomRowTop - 20,
        controlsOnBottomRow: trailingRects.every((t) => Math.abs(t.rect.top - bottomRowTop) < 8),
        flushRight: Math.abs(surfaceRect.right - rightmost.rect.right) < 20,
        maxTrailingGap: maxGap,
        trailingRects,
      };
    });
    console.log("WRAPPED-LAYOUT: " + JSON.stringify(layout));
    expect(layout.wrapped).toBe(true);
    expect(layout.textareaFullWidth).toBe(true);
    expect(layout.textareaOnTopRow).toBe(true);
    expect(layout.controlsOnBottomRow).toBe(true);
    // The whole trailing control group (model / send / plan-mode) stays flush
    // right with no auto-margin split between them.
    expect(layout.flushRight).toBe(true);
    expect(layout.maxTrailingGap).toBeLessThan(60);

    // Clearing the prompt returns to the single-row layout.
    await composer.fill("");
    await window.waitForTimeout(800);
    const cleared = await window.evaluate(() =>
      document.querySelector(".composer__surface")!.classList.contains("composer__surface--wrapped"),
    );
    console.log("WRAPPED-CLEARED: " + cleared);
    expect(cleared).toBe(false);
  } finally {
    await harness.close();
  }
});
