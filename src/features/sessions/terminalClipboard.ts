import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import type {
  ClipboardSelectionType,
  IBase64,
  IClipboardProvider,
} from "@xterm/addon-clipboard";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { ShortcutSettings } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS, matchesShortcut } from "../../shared/shortcuts";

export const MAX_REMOTE_CLIPBOARD_BYTES = 1024 * 1024;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class StrictClipboardBase64 implements IBase64 {
  encodeText(data: string) {
    const bytes = new TextEncoder().encode(data);
    if (bytes.byteLength > MAX_REMOTE_CLIPBOARD_BYTES) {
      throw new Error("剪贴板内容超过大小限制");
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return globalThis.btoa(binary);
  }

  decodeText(data: string) {
    const maxEncodedLength = Math.ceil(MAX_REMOTE_CLIPBOARD_BYTES / 3) * 4;
    if (
      data.length > maxEncodedLength ||
      data.length % 4 !== 0 ||
      !BASE64_PATTERN.test(data)
    ) {
      throw new Error("剪贴板 Base64 数据无效");
    }
    const binary = globalThis.atob(data);
    if (binary.length > MAX_REMOTE_CLIPBOARD_BYTES) {
      throw new Error("剪贴板内容超过大小限制");
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}

interface TauriClipboardProviderOptions {
  isAllowed: () => boolean;
  onWriteError: () => void;
  writer?: (text: string) => Promise<void>;
}

export class TauriClipboardProvider implements IClipboardProvider {
  private readonly isAllowed: () => boolean;
  private readonly onWriteError: () => void;
  private readonly writer: (text: string) => Promise<void>;

  constructor({
    isAllowed,
    onWriteError,
    writer = writeClipboardText,
  }: TauriClipboardProviderOptions) {
    this.isAllowed = isAllowed;
    this.onWriteError = onWriteError;
    this.writer = writer;
  }

  readText() {
    // 远端读取本机剪贴板风险更高。Provider 始终返回空值，不调用 Tauri 读取接口。
    return "";
  }

  async writeText(selection: ClipboardSelectionType, text: string) {
    // tmux 使用空选择目标表示默认系统剪贴板；Windows 终端会将它按 `c` 处理。
    const selectionName = selection as string;
    if (
      (selectionName !== "c" && selectionName !== "") ||
      !text ||
      !this.isAllowed() ||
      new TextEncoder().encode(text).byteLength > MAX_REMOTE_CLIPBOARD_BYTES
    ) {
      return;
    }
    try {
      await this.writer(text);
    } catch {
      // 剪贴板被其他程序占用时，只提示本次失败，不影响终端解析和 SSH 连接。
      this.onWriteError();
    }
  }
}

export function writeSystemClipboard(text: string) {
  return writeClipboardText(text);
}

export function readSystemClipboard() {
  return readClipboardText();
}

type TerminalMouseTrackingMode = XTerm["modes"]["mouseTrackingMode"];

interface TerminalMouseSelectionStart {
  button: number;
  mouseTrackingMode: TerminalMouseTrackingMode;
  pointerId: number;
  pointerType: string;
  shiftKey: boolean;
}

export function createTerminalMouseSelectionCopyState() {
  let pointerId: number | null = null;
  let selectionChanged = false;

  const cancel = () => {
    pointerId = null;
    selectionChanged = false;
  };

  const finishActiveSelection = (selection: string) => {
    if (pointerId === null) {
      return null;
    }
    const result = selectionChanged && selection ? selection : null;
    cancel();
    return result;
  };

  return {
    begin({
      button,
      mouseTrackingMode,
      pointerId: nextPointerId,
      pointerType,
      shiftKey,
    }: TerminalMouseSelectionStart) {
      cancel();
      if (
        pointerType !== "mouse" ||
        button !== 0 ||
        (mouseTrackingMode !== "none" && !shiftKey)
      ) {
        return false;
      }
      pointerId = nextPointerId;
      return true;
    },
    markSelectionChanged() {
      if (pointerId !== null) {
        selectionChanged = true;
      }
    },
    finish(releasedPointerId: number, selection: string) {
      if (pointerId === null || pointerId !== releasedPointerId) {
        return null;
      }
      return finishActiveSelection(selection);
    },
    finishMouse(selection: string) {
      // MouseEvent 没有 pointerId；仅在左键 mouseup 后调用，活动状态仍负责过滤无效手势。
      return finishActiveSelection(selection);
    },
    cancel,
    cancelPointer(cancelledPointerId: number) {
      if (pointerId === cancelledPointerId) {
        cancel();
      }
    },
  };
}

interface SerialClipboardWriterOptions {
  onError: () => void;
  writer?: (text: string) => Promise<void>;
}

export function createSerialClipboardWriter({
  onError,
  writer = writeSystemClipboard,
}: SerialClipboardWriterOptions) {
  let chain = Promise.resolve();
  return {
    write(text: string) {
      chain = chain.then(() => writer(text)).catch(onError);
      return chain;
    },
  };
}

interface TerminalClipboardShortcutEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

export type TerminalClipboardShortcutAction = "copy" | "paste" | null;

export function resolveTerminalClipboardShortcut(
  event: TerminalClipboardShortcutEvent,
  hasSelection: boolean,
  shortcuts: ShortcutSettings = DEFAULT_SHORTCUTS,
): TerminalClipboardShortcutAction {
  if (event.type !== "keydown") {
    return null;
  }
  if (
    hasSelection && matchesShortcut(event, shortcuts.terminalCopy)
  ) {
    return "copy";
  }
  if (matchesShortcut(event, shortcuts.terminalPaste)) {
    return "paste";
  }
  return null;
}
