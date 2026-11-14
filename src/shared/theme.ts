import type { ThemePreference } from "./api/types";

export type CustomTheme = "terracotta" | "mint" | "lavender" | "iridescentGlass" | "iceGlass";
export type ResolvedTheme = "light" | "dark" | CustomTheme;

export function isCustomTheme(theme: ResolvedTheme): theme is CustomTheme {
  return theme !== "light" && theme !== "dark";
}

export const THEME_STORAGE_KEY = "fstty.theme";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return ["system", "light", "dark", "terracotta", "mint", "lavender", "iridescentGlass", "iceGlass"].includes(value as string);
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
  const appearance = resolved === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = appearance;
  if (isCustomTheme(resolved)) document.documentElement.dataset.palette = resolved;
  else delete document.documentElement.dataset.palette;
  document.documentElement.style.colorScheme = appearance;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 缓存只用于避免首屏闪烁；不可用时以后端设置为准。
  }
  return resolved;
}
