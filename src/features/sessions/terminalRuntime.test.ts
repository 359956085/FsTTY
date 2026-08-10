import { describe, expect, it } from "vitest";
import { getTerminalTheme } from "./terminalRuntime";

describe("终端主题", () => {
  it("提供明暗两套可区分的终端配色", () => {
    const light = getTerminalTheme("light");
    const dark = getTerminalTheme("dark");
    expect(light.background).toBe("#ffffff");
    expect(dark.background).toBe("#080d11");
    expect(light.foreground).not.toBe(dark.foreground);
  });
});
