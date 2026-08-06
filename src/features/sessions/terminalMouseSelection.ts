import type { Terminal as XTerm } from "@xterm/xterm";
import {
  createSerialClipboardWriter,
  createTerminalMouseSelectionCopyState,
  writeSystemClipboard,
} from "./terminalClipboard";

interface SelectionTerminal {
  getSelection: XTerm["getSelection"];
  modes: XTerm["modes"];
  onSelectionChange: XTerm["onSelectionChange"];
}

interface TerminalMouseSelectionOptions {
  container: HTMLElement;
  isActive: () => boolean;
  isVisible: () => boolean;
  onWriteError: () => void;
  terminal: SelectionTerminal;
  writer?: (text: string) => Promise<void>;
}

export function installTerminalMouseSelectionCopy({
  container,
  isActive,
  isVisible,
  onWriteError,
  terminal,
  writer = writeSystemClipboard,
}: TerminalMouseSelectionOptions) {
  const state = createTerminalMouseSelectionCopyState();
  const clipboard = createSerialClipboardWriter({ onError: onWriteError, writer });
  const pendingReleaseTimers = new Set<number>();
  let disposed = false;

  const selectionChangeSubscription = terminal.onSelectionChange(() => {
    state.markSelectionChanged();
  });
  const copy = (selection: string | null) => {
    if (selection) {
      void clipboard.write(selection);
    }
  };
  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (
      !isActive() ||
      !isVisible() ||
      !(target instanceof Node) ||
      !container.contains(target)
    ) {
      state.cancel();
      return;
    }
    state.begin({
      button: event.button,
      mouseTrackingMode: terminal.modes.mouseTrackingMode,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      shiftKey: event.shiftKey,
    });
  };
  const handlePointerUp = (event: PointerEvent) => {
    const releasedPointerId = event.pointerId;
    // xterm 在紧随 pointerup 的 mouseup 中提交选区；下一任务仅作为 mouseup 丢失时的兜底。
    const timerId = window.setTimeout(() => {
      pendingReleaseTimers.delete(timerId);
      if (disposed) {
        state.cancelPointer(releasedPointerId);
        return;
      }
      copy(state.finish(releasedPointerId, terminal.getSelection()));
    }, 0);
    pendingReleaseTimers.add(timerId);
  };
  const handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    // window 冒泡阶段位于 xterm 的 document mouseup 之后；微任务再读取最终选区。
    queueMicrotask(() => {
      if (disposed) {
        state.cancel();
        return;
      }
      copy(state.finishMouse(terminal.getSelection()));
    });
  };
  const handlePointerCancel = (event: PointerEvent) => {
    state.cancelPointer(event.pointerId);
  };
  const cancel = () => state.cancel();

  window.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("mouseup", handleMouseUp);
  window.addEventListener("pointercancel", handlePointerCancel, true);
  window.addEventListener("blur", cancel);

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const timerId of pendingReleaseTimers) {
        window.clearTimeout(timerId);
      }
      pendingReleaseTimers.clear();
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("blur", cancel);
      selectionChangeSubscription.dispose();
      state.cancel();
    },
  };
}
