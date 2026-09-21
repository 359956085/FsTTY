import { describe, expect, it } from "vitest";
import { getTerminalTheme, TERMINAL_SCROLLBAR_SIZE } from "./terminalRuntime";

describe("终端主题", () => {
  it("终端自定义滚动条与全局设计宽度一致", () => {
    expect(TERMINAL_SCROLLBAR_SIZE).toBe(8);
  });

  it("提供明暗两套可区分的终端配色", () => {
    const light = getTerminalTheme("light");
    const dark = getTerminalTheme("dark");
    expect(light.background).toBe("#f6f8fa");
    expect(light.cursorAccent).toBe(light.background);
    expect(dark.background).toBe("#080d11");
    expect(light.foreground).not.toBe(dark.foreground);
    expect(light.overviewRulerBorder).toBe("#00000000");
    expect(dark.overviewRulerBorder).toBe("#00000000");
  });

  it.each([
    ["ayuMirage", "#ed8274", "#73d0ff"],
    ["catppuccin", "#f38ba8", "#89b4fa"],
    ["dracula", "#ff5555", "#d6acff"],
    ["everforest", "#e67e80", "#3a94c5"],
    ["gruvbox", "#cc241d", "#83a598"],
    ["kanagawa", "#c34043", "#7fb4ca"],
    ["nord", "#bf616a", "#81a1c1"],
    ["oneHalf", "#e06c75", "#61afef"],
    ["rosePine", "#eb6f92", "#9ccfd8"],
    ["solarized", "#dc322f", "#839496"],
  ] as const)(
    "预设只改变 ANSI 配色，保留明暗背景、普通文字和选区：%s",
    (colorScheme, red, brightBlue) => {
      for (const theme of ["light", "dark"] as const) {
        const base = getTerminalTheme(theme);
        const selected = getTerminalTheme(theme, colorScheme);
        expect(selected.red).not.toBe(base.red);
        expect(selected.red).toBe(red);
        expect(selected.brightBlue).toBe(brightBlue);
        for (const key of ["background", "foreground", "cursor", "cursorAccent", "selectionBackground", "overviewRulerBorder"] as const) {
          expect(selected[key]).toBe(base[key]);
        }
      }
    },
  );

  it("切回默认配色不会残留预设颜色或修改内置配色", () => {
    const original = getTerminalTheme("dark");
    const selected = getTerminalTheme("dark", "dracula");
    expect(selected.red).toBe("#ff5555");
    expect(selected.brightBlue).toBe("#d6acff");
    selected.red = "#000000";
    expect(getTerminalTheme("dark", "default")).toEqual(original);
    expect(getTerminalTheme("dark", "dracula").red).toBe("#ff5555");
  });
});
