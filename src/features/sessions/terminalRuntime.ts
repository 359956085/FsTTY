import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { ResolvedTheme } from "../../shared/theme";
import { StrictClipboardBase64, TauriClipboardProvider } from "./terminalClipboard";
import { installTerminalMouseSelectionCopy } from "./terminalMouseSelection";

interface InstallTerminalRuntimeOptions {
  container: HTMLElement;
  isActive: () => boolean;
  isCancelled: () => boolean;
  isRemoteClipboardAllowed: () => boolean;
  isVisible: () => boolean;
  onClipboardWriteError: () => void;
  theme: ResolvedTheme;
}

export interface InstalledTerminalRuntime {
  dispose(): void;
  fitAddon: XTermFitAddon;
  terminal: XTerm;
}

export const TERMINAL_SCROLLBAR_SIZE = 8;

const TERMINAL_THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#080d11",
    foreground: "#d5d9dd",
    cursor: "#f1f3f5",
    cursorAccent: "#080d11",
    black: "#111416",
    red: "#f06b72",
    green: "#56cf63",
    yellow: "#e5aa4b",
    blue: "#aeb6bd",
    magenta: "#c792ea",
    cyan: "#2dd4bf",
    white: "#d5d9dd",
    brightBlack: "#6f7780",
    brightWhite: "#f4f6f8",
    overviewRulerBorder: "#00000000",
    selectionBackground: "#5b6b7c66",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f2933",
    cursor: "#1f2933",
    cursorAccent: "#ffffff",
    black: "#1f2933",
    red: "#c43c49",
    green: "#257a3e",
    yellow: "#946200",
    blue: "#1668c7",
    magenta: "#7b4ab5",
    cyan: "#087f8c",
    white: "#e7ebef",
    brightBlack: "#66717d",
    brightWhite: "#ffffff",
    overviewRulerBorder: "#00000000",
    selectionBackground: "#2588f533",
  },
};

export function getTerminalTheme(theme: ResolvedTheme): ITheme {
  return TERMINAL_THEMES[theme];
}

export async function installTerminalRuntime({
  container,
  isActive,
  isCancelled,
  isRemoteClipboardAllowed,
  isVisible,
  onClipboardWriteError,
  theme,
}: InstallTerminalRuntimeOptions): Promise<InstalledTerminalRuntime | null> {
  const [{ Terminal }, { FitAddon }, { ClipboardAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-clipboard"),
  ]);
  if (isCancelled()) {
    return null;
  }

  const terminal = new Terminal({
    convertEol: false,
    cursorBlink: true,
    fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.38,
    // xterm 6 使用独立滚动条，必须通过 overviewRuler 覆盖默认的 14px 宽度。
    overviewRuler: { width: TERMINAL_SCROLLBAR_SIZE },
    scrollback: 10_000,
    theme: getTerminalTheme(theme),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(
    new ClipboardAddon(
      new StrictClipboardBase64(),
      new TauriClipboardProvider({
        isAllowed: isRemoteClipboardAllowed,
        onWriteError: onClipboardWriteError,
      }),
    ),
  );
  terminal.open(container);
  const mouseSelection = installTerminalMouseSelectionCopy({
    container,
    isActive,
    isVisible,
    onWriteError: onClipboardWriteError,
    terminal,
  });
  let disposed = false;

  return {
    fitAddon,
    terminal,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // 先撤销全局事件，再销毁 xterm，避免监听器读取已释放的终端实例。
      mouseSelection.dispose();
      terminal.dispose();
    },
  };
}
