import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { StrictClipboardBase64, TauriClipboardProvider } from "./terminalClipboard";
import { installTerminalMouseSelectionCopy } from "./terminalMouseSelection";

interface InstallTerminalRuntimeOptions {
  container: HTMLElement;
  isActive: () => boolean;
  isCancelled: () => boolean;
  isRemoteClipboardAllowed: () => boolean;
  isVisible: () => boolean;
  onClipboardWriteError: () => void;
}

export interface InstalledTerminalRuntime {
  dispose(): void;
  fitAddon: XTermFitAddon;
  terminal: XTerm;
}

export async function installTerminalRuntime({
  container,
  isActive,
  isCancelled,
  isRemoteClipboardAllowed,
  isVisible,
  onClipboardWriteError,
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
    scrollback: 10_000,
    theme: {
      background: "#080d11",
      foreground: "#d5d9dd",
      cursor: "#f1f3f5",
      black: "#111416",
      blue: "#aeb6bd",
      cyan: "#2dd4bf",
      green: "#56cf63",
      red: "#f06b72",
      yellow: "#e5aa4b",
    },
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
