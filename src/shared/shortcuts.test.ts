import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcut,
  matchesShortcut,
  shortcutFromEvent,
  validateShortcut,
} from "./shortcuts";

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    code: "KeyF",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("快捷键", () => {
  it("使用物理按键编码匹配并格式化", () => {
    expect(matchesShortcut(keyboardEvent(), DEFAULT_SHORTCUTS.commandHistorySearch)).toBe(true);
    expect(formatShortcut(DEFAULT_SHORTCUTS.commandHistory)).toBe("Ctrl+Shift+H");
    expect(shortcutFromEvent(keyboardEvent())).toEqual(DEFAULT_SHORTCUTS.commandHistorySearch);
  });

  it("拒绝无 Ctrl 或 Alt、系统保留和不支持按键", () => {
    expect(validateShortcut({ code: "KeyA", ctrl: false, alt: false, shift: true })).toBe(
      "modifierRequired",
    );
    expect(validateShortcut({ code: "F4", ctrl: false, alt: true, shift: false })).toBe(
      "reserved",
    );
    expect(validateShortcut({ code: "Escape", ctrl: true, alt: false, shift: false })).toBe(
      "unsupported",
    );
  });

  it("发现动作间冲突", () => {
    expect(
      findShortcutConflict(
        DEFAULT_SHORTCUTS,
        "commandHistorySearch",
        DEFAULT_SHORTCUTS.terminalCopy,
      ),
    ).toBe("terminalCopy");
  });
});
