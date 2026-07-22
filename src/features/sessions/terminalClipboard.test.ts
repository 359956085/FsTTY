import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_REMOTE_CLIPBOARD_BYTES,
  StrictClipboardBase64,
  TauriClipboardProvider,
} from "./terminalClipboard";

const SYSTEM = "c" as ClipboardSelectionType;
const DEFAULT = "" as ClipboardSelectionType;
const PRIMARY = "p" as ClipboardSelectionType;

describe("StrictClipboardBase64", () => {
  const base64 = new StrictClipboardBase64();

  it("保留 Unicode 和换行", () => {
    const value = "第一行\nCodex 中文 ✅";
    expect(base64.decodeText(base64.encodeText(value))).toBe(value);
  });

  it("拒绝非法 Base64", () => {
    expect(() => base64.decodeText("not-base64")).toThrow();
  });

  it("拒绝非法 UTF-8", () => {
    expect(() => base64.decodeText("/w==")).toThrow();
  });

  it("拒绝超限内容", () => {
    const oversized = "A".repeat(Math.ceil(MAX_REMOTE_CLIPBOARD_BYTES / 3) * 4 + 4);
    expect(() => base64.decodeText(oversized)).toThrow();
    expect(() => base64.encodeText("a".repeat(MAX_REMOTE_CLIPBOARD_BYTES + 1))).toThrow();
  });
});

describe("TauriClipboardProvider", () => {
  it("只允许活动会话写入系统剪贴板", async () => {
    const writer = vi.fn(async () => undefined);
    const provider = new TauriClipboardProvider({
      isAllowed: () => true,
      onWriteError: vi.fn(),
      writer,
    });

    await provider.writeText(SYSTEM, "tmux copy");
    await provider.writeText(PRIMARY, "primary");
    await provider.writeText(SYSTEM, "");

    expect(writer).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith("tmux copy");
    expect(await provider.readText()).toBe("");
  });

  it("将 tmux 的空选择目标写入系统剪贴板", async () => {
    const writer = vi.fn(async () => undefined);
    const provider = new TauriClipboardProvider({
      isAllowed: () => true,
      onWriteError: vi.fn(),
      writer,
    });

    await provider.writeText(DEFAULT, "tmux copy");

    expect(writer).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith("tmux copy");
  });

  it("禁用时忽略远程写入", async () => {
    const writer = vi.fn(async () => undefined);
    const provider = new TauriClipboardProvider({
      isAllowed: () => false,
      onWriteError: vi.fn(),
      writer,
    });

    await provider.writeText(SYSTEM, "blocked");
    expect(writer).not.toHaveBeenCalled();
  });

  it("忽略超限文本", async () => {
    const writer = vi.fn(async () => undefined);
    const provider = new TauriClipboardProvider({
      isAllowed: () => true,
      onWriteError: vi.fn(),
      writer,
    });

    await provider.writeText(SYSTEM, "a".repeat(MAX_REMOTE_CLIPBOARD_BYTES + 1));
    expect(writer).not.toHaveBeenCalled();
  });

  it("写入失败只报告错误", async () => {
    const onWriteError = vi.fn();
    const provider = new TauriClipboardProvider({
      isAllowed: () => true,
      onWriteError,
      writer: async () => {
        throw new Error("clipboard busy");
      },
    });

    await expect(provider.writeText(SYSTEM, "value")).resolves.toBeUndefined();
    expect(onWriteError).toHaveBeenCalledOnce();
  });
});
