import type { ITheme } from "@xterm/xterm";
import type { CustomTheme } from "./theme";

// Match the terminal surface tokens in theme-palettes.css. ANSI colors are
// deliberately inherited from the existing light palette, never recolored.
export const CUSTOM_TERMINAL_SURFACES: Record<CustomTheme, ITheme> = {
  terracotta: {
    background: "#fffaf6", foreground: "#38271f", cursor: "#c8582b",
    cursorAccent: "#fffaf6", selectionBackground: "#d4643433",
  },
  mint: {
    background: "#f8fdfb", foreground: "#16352f", cursor: "#199b70",
    cursorAccent: "#f8fdfb", selectionBackground: "#20b58333",
  },
  lavender: {
    background: "#fcfaff", foreground: "#2c2144", cursor: "#8650d9",
    cursorAccent: "#fcfaff", selectionBackground: "#9660e433",
  },
  // The RGB channels describe the glass backing, even when the surface is
  // fully transparent: xterm uses them for contrast, inverse text and selection.
  iridescentGlass: {
    background: "#ecedf900", foreground: "#20263f", cursor: "#3268cf",
    cursorAccent: "#f1f2fc", selectionBackground: "#568be852",
    selectionForeground: "#17233d",
  },
  iceGlass: {
    background: "#28658b00", foreground: "#f5fbff", cursor: "#a4f3ff",
    cursorAccent: "#173e59", selectionBackground: "#86e9ff66",
    selectionForeground: "#ffffff",
  },
};
