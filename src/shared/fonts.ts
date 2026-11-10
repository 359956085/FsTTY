import type { FontFamilyPreference } from "./api/types";

export const FONT_FAMILIES = ["default", "jetBrainsMono", "cascadiaMono", "cascadiaCode", "consolas", "courierNew", "lucidaConsole", "firaCode", "sourceCodePro"] as const satisfies readonly FontFamilyPreference[];
export const BUNDLED_FONT_FAMILY = "FsTTY JetBrains Mono";
export const DEFAULT_UI_FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DEFAULT_MONO_FONT = '"Cascadia Mono", "JetBrains Mono", Consolas, monospace';
const families: Record<Exclude<FontFamilyPreference, "default">, string> = {
  jetBrainsMono: BUNDLED_FONT_FAMILY,
  cascadiaMono: "Cascadia Mono",
  cascadiaCode: "Cascadia Code",
  consolas: "Consolas",
  courierNew: "Courier New",
  lucidaConsole: "Lucida Console",
  firaCode: "Fira Code",
  sourceCodePro: "Source Code Pro",
};

export function isFontFamily(value: unknown): value is FontFamilyPreference {
  return FONT_FAMILIES.some((family) => family === value);
}

export function getFontLabel(family: Exclude<FontFamilyPreference, "default">): string {
  return family === "jetBrainsMono" ? "JetBrains Mono" : families[family];
}

export function getFontStacks(preference: FontFamilyPreference) {
  const first = preference === "default" ? "" : `"${families[preference]}", `;
  return { ui: first + DEFAULT_UI_FONT, mono: first + DEFAULT_MONO_FONT };
}

export function applyFontFamily(preference: FontFamilyPreference) {
  const stacks = getFontStacks(preference);
  document.documentElement.style.setProperty("--app-font-family", stacks.ui);
  if (preference === "default") document.documentElement.style.removeProperty("--app-mono-font-family");
  else document.documentElement.style.setProperty("--app-mono-font-family", stacks.mono);
}

// One offline resource load shared across tabs; a failed load can be retried.
export function createBundledFontLoader(getFonts: () => Pick<FontFaceSet, "load"> = () => document.fonts) {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    pending = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Bundled font loading timed out")), 5000);
      Promise.resolve().then(() => {
        const fonts = getFonts();
        return Promise.all(["normal 400", "normal 700", "italic 400", "italic 700"].map((style) =>
          fonts.load(`${style} 14px "${BUNDLED_FONT_FAMILY}"`, "FsTTY 012Abc"),
        ));
      }).then((loaded) => {
        if (loaded.some((faces) => faces.length === 0)) throw new Error("Bundled font is unavailable");
        resolve();
      }).catch(reject).finally(() => clearTimeout(timeout));
    }).catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

export const loadBundledFont = createBundledFontLoader();
