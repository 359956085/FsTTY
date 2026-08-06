import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import {
  MAX_REMOTE_CLIPBOARD_BYTES,
  StrictClipboardBase64,
  TauriClipboardProvider,
  createSerialClipboardWriter,
  createTerminalMouseSelectionCopyState,
  resolveTerminalClipboardShortcut,
} from "./terminalClipboard";

const SYSTEM = "c" as ClipboardSelectionType;
const DEFAULT = "" as ClipboardSelectionType;
const PRIMARY = "p" as ClipboardSelectionType;

function shortcutEvent(
  overrides: Partial<{
    altKey: boolean;
    code: string;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
    type: string;
  }> = {},
) {
  const key = overrides.key ?? "";
  return {
    altKey: false,
    code: overrides.code ?? (key ? `Key${key.toUpperCase()}` : ""),
    ctrlKey: true,
    key,
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    ...overrides,
  };
}

describe("resolveTerminalClipboardShortcut", () => {
  it("有选区时按配置识别复制快捷键", () => {
    expect(
      resolveTerminalClipboardShortcut(shortcutEvent({ key: "c" }), true),
    ).toBe("copy");
    const custom = {
      ...DEFAULT_SHORTCUTS,
      terminalCopy: { ...DEFAULT_SHORTCUTS.terminalCopy, shift: true },
    };
    expect(
      resolveTerminalClipboardShortcut(shortcutEvent({ key: "C", shiftKey: true }), true, custom),
    ).toBe("copy");
  });

  it("无选区时保留远程 Ctrl+C", () => {
    expect(
      resolveTerminalClipboardShortcut(shortcutEvent({ key: "c" }), false),
    ).toBeNull();
  });

  it("只将 Ctrl+V 识别为粘贴", () => {
    expect(
      resolveTerminalClipboardShortcut(shortcutEvent({ key: "v" }), false),
    ).toBe("paste");
    expect(
      resolveTerminalClipboardShortcut(
        shortcutEvent({ key: "v", shiftKey: true }),
        false,
      ),
    ).toBeNull();
  });

  it("忽略按键抬起、非 Ctrl 和 Alt 或 Meta 组合", () => {
    expect(
      resolveTerminalClipboardShortcut(
        shortcutEvent({ key: "v", type: "keyup" }),
        false,
      ),
    ).toBeNull();
    expect(
      resolveTerminalClipboardShortcut(
        shortcutEvent({ ctrlKey: false, key: "v" }),
        false,
      ),
    ).toBeNull();
    expect(
      resolveTerminalClipboardShortcut(
        shortcutEvent({ altKey: true, key: "v" }),
        false,
      ),
    ).toBeNull();
    expect(
      resolveTerminalClipboardShortcut(
        shortcutEvent({ key: "v", metaKey: true }),
        false,
      ),
    ).toBeNull();
  });
});

describe("createTerminalMouseSelectionCopyState", () => {
  it("普通左键选择只在匹配指针松开后返回最终文本", () => {
    const state = createTerminalMouseSelectionCopyState();
    expect(
      state.begin({
        button: 0,
        mouseTrackingMode: "none",
        pointerId: 7,
        pointerType: "mouse",
        shiftKey: false,
      }),
    ).toBe(true);
    state.markSelectionChanged();
    state.markSelectionChanged();

    expect(state.finish(8, "错误指针")).toBeNull();
    expect(state.finish(7, "最终文本")).toBe("最终文本");
    expect(state.finish(7, "重复释放")).toBeNull();
  });

  it("mouseup 可完成选择，随后 pointerup 兜底不会重复返回", () => {
    const state = createTerminalMouseSelectionCopyState();
    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 7,
      pointerType: "mouse",
      shiftKey: false,
    });

    // 实际事件顺序中，pointerup 先发生，xterm 到 mouseup 才发出选择变化。
    state.markSelectionChanged();
    expect(state.finishMouse("最终文本")).toBe("最终文本");
    expect(state.finish(7, "重复释放")).toBeNull();
  });

  it("只有 mouseup 时仍可完成选择", () => {
    const state = createTerminalMouseSelectionCopyState();
    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 8,
      pointerType: "mouse",
      shiftKey: false,
    });
    state.markSelectionChanged();

    expect(state.finishMouse("mouseup 兜底")).toBe("mouseup 兜底");
    expect(state.finishMouse("重复 mouseup")).toBeNull();
  });

  it("未改变选区或最终选区为空时不复制旧内容", () => {
    const state = createTerminalMouseSelectionCopyState();
    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 1,
      pointerType: "mouse",
      shiftKey: false,
    });
    expect(state.finish(1, "旧选区")).toBeNull();

    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 2,
      pointerType: "mouse",
      shiftKey: false,
    });
    state.markSelectionChanged();
    expect(state.finish(2, "")).toBeNull();
  });

  it("远端鼠标模式只允许按住 Shift 的左键选择", () => {
    const state = createTerminalMouseSelectionCopyState();
    expect(
      state.begin({
        button: 0,
        mouseTrackingMode: "any",
        pointerId: 1,
        pointerType: "mouse",
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      state.begin({
        button: 0,
        mouseTrackingMode: "drag",
        pointerId: 2,
        pointerType: "mouse",
        shiftKey: true,
      }),
    ).toBe(true);
    state.markSelectionChanged();
    expect(state.finish(2, "Shift 选区")).toBe("Shift 选区");
  });

  it("忽略非鼠标左键并支持取消当前手势", () => {
    const state = createTerminalMouseSelectionCopyState();
    expect(
      state.begin({
        button: 2,
        mouseTrackingMode: "none",
        pointerId: 1,
        pointerType: "mouse",
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      state.begin({
        button: 0,
        mouseTrackingMode: "none",
        pointerId: 2,
        pointerType: "touch",
        shiftKey: false,
      }),
    ).toBe(false);

    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 3,
      pointerType: "mouse",
      shiftKey: false,
    });
    state.markSelectionChanged();
    state.cancelPointer(4);
    expect(state.finish(3, "仍有效")).toBe("仍有效");

    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 5,
      pointerType: "mouse",
      shiftKey: false,
    });
    state.markSelectionChanged();
    state.cancelPointer(5);
    expect(state.finish(5, "已取消")).toBeNull();

    state.begin({
      button: 0,
      mouseTrackingMode: "none",
      pointerId: 6,
      pointerType: "mouse",
      shiftKey: false,
    });
    state.markSelectionChanged();
    state.cancel();
    expect(state.finish(6, "失焦或卸载后取消")).toBeNull();
  });
});

describe("createSerialClipboardWriter", () => {
  it("按选择完成顺序串行写入", async () => {
    let releaseFirst: (() => void) | undefined;
    const calls: string[] = [];
    const writer = createSerialClipboardWriter({
      onError: vi.fn(),
      writer: async (text) => {
        calls.push(text);
        if (text === "first") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });

    const first = writer.write("first");
    const second = writer.write("second");
    await Promise.resolve();
    expect(calls).toEqual(["first"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("写入失败报告错误且后续复制继续执行", async () => {
    const onError = vi.fn();
    const clipboard = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("clipboard busy"))
      .mockResolvedValue(undefined);
    const writer = createSerialClipboardWriter({ onError, writer: clipboard });

    await writer.write("first");
    await writer.write("second");

    expect(onError).toHaveBeenCalledOnce();
    expect(clipboard).toHaveBeenNthCalledWith(1, "first");
    expect(clipboard).toHaveBeenNthCalledWith(2, "second");
  });
});

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
    expect(provider.readText()).toBe("");
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
