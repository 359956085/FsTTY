import { describe, expect, it } from "vitest";
import { getTerminalTheme, TERMINAL_SCROLLBAR_SIZE } from "./terminalRuntime";

describe("终端主题", () => {
  it("终端自定义滚动条与全局设计宽度一致", () => {
    expect(TERMINAL_SCROLLBAR_SIZE).toBe(8);
  });

  it("提供明暗两套可区分的终端配色", () => {
    const light = getTerminalTheme("light");
    const dark = getTerminalTheme("dark");
    expect(light.background).toBe("#ffffff");
    expect(dark.background).toBe("#080d11");
    expect(light.foreground).not.toBe(dark.foreground);
    expect(light.overviewRulerBorder).toBe("#00000000");
    expect(dark.overviewRulerBorder).toBe("#00000000");
  });
});
