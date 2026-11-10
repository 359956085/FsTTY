// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFontFamily, BUNDLED_FONT_FAMILY, createBundledFontLoader, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, FONT_FAMILIES, getFontStacks, isFontFamily } from "./fonts";

afterEach(() => { vi.useRealTimers(); document.documentElement.removeAttribute("style"); });

describe("font families", () => {
  it("preserves default UI and terminal stacks and maps every preset", () => {
    expect(getFontStacks("default")).toEqual({ ui: DEFAULT_UI_FONT, mono: DEFAULT_MONO_FONT });
    for (const value of FONT_FAMILIES) {
      expect(isFontFamily(value)).toBe(true);
      expect(getFontStacks(value).mono.endsWith("monospace")).toBe(true);
    }
    expect(isFontFamily("Arial")).toBe(false);
    expect(isFontFamily(null)).toBe(false);
    const stacks = getFontStacks("jetBrainsMono");
    expect(stacks.ui.startsWith('"FsTTY JetBrains Mono"')).toBe(true);
    expect(stacks.mono.startsWith('"FsTTY JetBrains Mono"')).toBe(true);
    applyFontFamily("consolas");
    expect(document.documentElement.style.getPropertyValue("--app-font-family")).toBe(getFontStacks("consolas").ui);
    expect(document.documentElement.style.getPropertyValue("--app-mono-font-family")).toBe(getFontStacks("consolas").mono);
    applyFontFamily("default");
    expect(document.documentElement.style.getPropertyValue("--app-mono-font-family")).toBe("");
  });

  it("loads all four bundled faces once and shares pending/completed work", async () => {
    const load = vi.fn().mockResolvedValue([{}]);
    const ensure = createBundledFontLoader(() => ({ load }));
    const first = ensure();
    expect(ensure()).toBe(first);
    await first;
    await ensure();
    expect(load.mock.calls.map(([face]) => String(face))).toEqual(
      ["normal 400", "normal 700", "italic 400", "italic 700"].map(style => style + ' 14px "' + BUNDLED_FONT_FAMILY + '"'),
    );
  });

  it("reports missing faces and permits a later retry", async () => {
    const load = vi.fn().mockResolvedValue([]);
    const ensure = createBundledFontLoader(() => ({ load }));
    await expect(ensure()).rejects.toThrow("unavailable");
    load.mockResolvedValue([{}]);
    await ensure();
    expect(load).toHaveBeenCalledTimes(8);
  });

  it("handles unsupported font loading and bounds a stalled load", async () => {
    const unsupported = createBundledFontLoader(() => { throw new Error("unsupported"); });
    await expect(unsupported()).rejects.toThrow("unsupported");
    vi.useFakeTimers();
    const ensure = createBundledFontLoader(() => ({ load: () => new Promise(() => undefined) }));
    const expected = expect(ensure()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await expected;
  });
});
