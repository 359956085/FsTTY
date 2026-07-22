import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import type {
  ClipboardSelectionType,
  IBase64,
  IClipboardProvider,
} from "@xterm/addon-clipboard";

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

interface TerminalClipboardShortcutEvent {
  altKey: boolean;
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
): TerminalClipboardShortcutAction {
  if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key === "c" && hasSelection) {
    return "copy";
  }
  if (key === "v" && !event.shiftKey) {
    return "paste";
  }
  return null;
}
