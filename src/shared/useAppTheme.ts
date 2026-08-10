import { useEffect, useState } from "react";
import type { ThemePreference } from "./api/types";
import {
  applyTheme,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  type ResolvedTheme,
} from "./theme";

function getSystemThemeMedia(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(SYSTEM_DARK_QUERY)
    : null;
}

function systemPrefersDark() {
  return getSystemThemeMedia()?.matches ?? false;
}

export function useAppTheme(preference: ThemePreference): ResolvedTheme {
  const [resolved, setResolved] = useState(() =>
    resolveTheme(preference, systemPrefersDark()),
  );

  useEffect(() => {
    const media = getSystemThemeMedia();
    const sync = () =>
      setResolved(applyTheme(preference, media?.matches ?? false));
    sync();
    if (preference !== "system" || !media) {
      return;
    }
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [preference]);

  return resolved;
}
