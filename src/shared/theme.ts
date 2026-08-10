import type { ThemePreference } from "./api/types";

export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "fstty.theme";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readCachedThemePreference(): ThemePreference {
  try {
    const cached = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(cached) ? cached : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function applyTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 缓存只用于避免首屏闪烁；不可用时以后端设置为准。
  }
  return resolved;
}
