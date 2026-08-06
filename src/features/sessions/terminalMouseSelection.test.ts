// @vitest-environment jsdom

import type { Terminal as XTerm } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTerminalMouseSelectionCopy } from "./terminalMouseSelection";

function pointerEvent(
  type: string,
  options: { button?: number; pointerId?: number; shiftKey?: boolean } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: options.button ?? 0,
    shiftKey: options.shiftKey ?? false,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: "mouse" },
  });
  return event;
}

function setup(mouseTrackingMode: XTerm["modes"]["mouseTrackingMode"] = "none") {
  const container = document.createElement("div");
  const target = document.createElement("span");
  container.append(target);
  document.body.append(container);
  let selection = "";
  let selectionChanged: () => void = () => undefined;
  const writer = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const terminal = {
    getSelection: () => selection,
    modes: { mouseTrackingMode } as XTerm["modes"],
    onSelectionChange(listener: () => void) {
      selectionChanged = listener;
      return { dispose: vi.fn() };
    },
  };
  const installation = installTerminalMouseSelectionCopy({
    container,
    isActive: () => true,
    isVisible: () => true,
    onWriteError: vi.fn(),
    terminal,
    writer,
  });
  return {
    installation,
    select(value: string) {
      selection = value;
      selectionChanged();
    },
    target,
    writer,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("installTerminalMouseSelectionCopy", () => {
  it("按真实 pointerup、mouseup、选择变化顺序只复制一次", async () => {
    vi.useFakeTimers();
    const state = setup();
    const commitSelection = () => state.select("最终文本");
    document.addEventListener("mouseup", commitSelection, { once: true });

    state.target.dispatchEvent(pointerEvent("pointerdown"));
    state.target.dispatchEvent(pointerEvent("pointerup"));
    state.target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await vi.runAllTimersAsync();

    expect(state.writer).toHaveBeenCalledOnce();
    expect(state.writer).toHaveBeenCalledWith("最终文本");
    state.installation.dispose();
  });

  it("远端鼠标模式要求 Shift，取消和卸载不复制", async () => {
    vi.useFakeTimers();
    const state = setup("any");

    state.target.dispatchEvent(pointerEvent("pointerdown"));
    state.select("远端普通拖动");
    state.target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));

    state.target.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, shiftKey: true }));
    state.select("Shift 选区");
    window.dispatchEvent(pointerEvent("pointercancel", { pointerId: 2 }));
    state.target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));

    state.target.dispatchEvent(pointerEvent("pointerdown", { pointerId: 3, shiftKey: true }));
    state.select("卸载选区");
    state.installation.dispose();
    state.target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await vi.runAllTimersAsync();

    expect(state.writer).not.toHaveBeenCalled();
  });
});
