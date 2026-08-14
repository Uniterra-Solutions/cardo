/**
 * Cardo PBT: desktop shortcut → command mapping invariants.
 *
 * Locks down `getDesktopCommandFromShortcut`:
 *  - Cmd+N opens a new thread (renderer-side command, sent via IPC)
 *  - Cmd+Shift+N is NOT a desktop command (new window is main-process only)
 *  - Cmd+Alt+J toggles the files panel; plain Cmd+J keeps toggling the terminal
 *  - Cmd+B toggles the sidebar, Cmd+, opens settings, Cmd+Shift+O opens a thread
 *  - without the platform modifier nothing maps
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopCommands,
  getDesktopCommandFromShortcut,
  type DesktopShortcutInput,
} from "../../out-pbt/desktop/src/ipc.js";

function shortcut(input: Partial<DesktopShortcutInput> & Pick<DesktopShortcutInput, "key">) {
  return getDesktopCommandFromShortcut({
    modifier: false,
    shift: false,
    alt: false,
    code: undefined,
    ...input,
  });
}

test("Cmd+N maps to openNewThread regardless of case/code", () => {
  assert.equal(shortcut({ modifier: true, key: "n", code: "KeyN" }), desktopCommands.openNewThread);
  assert.equal(shortcut({ modifier: true, key: "N" }), desktopCommands.openNewThread);
});

test("Cmd+Shift+N is not a desktop command (main process opens a window instead)", () => {
  assert.equal(shortcut({ modifier: true, shift: true, key: "n" }), undefined);
});

test("Cmd+Alt+J maps to toggleFiles", () => {
  assert.equal(shortcut({ modifier: true, alt: true, key: "j", code: "KeyJ" }), desktopCommands.toggleFiles);
  assert.equal(shortcut({ modifier: true, alt: true, key: "J" }), desktopCommands.toggleFiles);
});

test("plain Cmd+J still maps to toggleTerminal", () => {
  assert.equal(shortcut({ modifier: true, key: "j", code: "KeyJ" }), desktopCommands.toggleTerminal);
});

test("existing shortcuts keep their commands", () => {
  assert.equal(shortcut({ modifier: true, key: "," }), desktopCommands.openSettings);
  assert.equal(shortcut({ modifier: true, key: "b" }), desktopCommands.toggleSidebar);
  assert.equal(shortcut({ modifier: true, shift: true, key: "o" }), desktopCommands.openNewThread);
});

test("without the platform modifier nothing maps, even with alt/shift", () => {
  assert.equal(shortcut({ key: "n" }), undefined);
  assert.equal(shortcut({ alt: true, key: "j" }), undefined);
  assert.equal(shortcut({ shift: true, key: "n" }), undefined);
});
