// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  isThemePreference,
  readCachedThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "./theme";

describe("应用主题", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("缺失或损坏的启动缓存回退为系统主题", () => {
    expect(readCachedThemePreference()).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "broken");
    expect(readCachedThemePreference()).toBe("system");
    expect(isThemePreference(null)).toBe(false);
  });

  it("解析三种主题并同步根节点与启动缓存", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");

    expect(applyTheme("light", true)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });
});
