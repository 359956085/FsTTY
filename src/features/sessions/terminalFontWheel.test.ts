// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installTerminalFontWheel } from "./terminalFontWheel";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";

describe("terminal Ctrl + wheel", () => {
  it("captures Ctrl only before xterm, normalizes deltas and cleans up", () => {
    const host = document.createElement("div"), child = document.createElement("div");
    host.append(child);
    const adjust = vi.fn(), remoteMouse = vi.fn();
    child.addEventListener("wheel", remoteMouse);
    let enabled = true;
    const dispose = installTerminalFontWheel(host, adjust, () => enabled);
    const wheel = (options: WheelEventInit = {}) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, ...options });
      child.dispatchEvent(event);
      return event;
    };
    expect(wheel().defaultPrevented).toBe(true);
    expect(adjust.mock.calls).toEqual([[1]]);
    expect(remoteMouse).not.toHaveBeenCalled();
    wheel({ deltaY: 100 });
    expect(adjust).toHaveBeenLastCalledWith(-1);
    adjust.mockClear();
    for (let i = 0; i < 4; i++) wheel({ deltaY: -25 });
    expect(adjust.mock.calls).toEqual([[1]]);
    wheel({ deltaY: 3, deltaMode: 1 });
    expect(adjust).toHaveBeenLastCalledWith(-1);
    wheel({ deltaY: -1, deltaMode: 2 });
    expect(adjust).toHaveBeenLastCalledWith(1);
    expect(wheel({ ctrlKey: false }).defaultPrevented).toBe(false);
    expect(wheel({ altKey: true }).defaultPrevented).toBe(true);
    enabled = false;
    expect(wheel().defaultPrevented).toBe(false);
    enabled = true;
    dispose();
    expect(wheel().defaultPrevented).toBe(false);
  });

  it("uses current per-direction bindings and keeps cleared Ctrl gestures from zooming", () => {
    const host = document.createElement("div"), adjust = vi.fn();
    let shortcuts = { ...DEFAULT_SHORTCUTS };
    const dispose = installTerminalFontWheel(host, adjust, () => true, () => shortcuts);
    const wheel = (options: WheelEventInit) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...options });
      host.dispatchEvent(event);
      return event;
    };
    shortcuts = { ...shortcuts, terminalFontIncrease: { code: "Equal", ctrl: true, alt: false, shift: false } };
    expect(wheel({ ctrlKey: true, deltaY: -100 }).defaultPrevented).toBe(true);
    expect(adjust).not.toHaveBeenCalled();
    wheel({ ctrlKey: true, deltaY: 100 });
    expect(adjust).toHaveBeenLastCalledWith(-1);
    shortcuts = { ...shortcuts, terminalFontDecrease: null, terminalFontIncrease: { code: "WheelDown", ctrl: false, alt: true, shift: false } };
    adjust.mockClear();
    wheel({ ctrlKey: true, deltaY: 100 });
    expect(adjust).not.toHaveBeenCalled();
    expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(false);
    wheel({ altKey: true, deltaY: 100 });
    expect(adjust).toHaveBeenLastCalledWith(1);
    dispose();
  });

  it("does not combine small deltas across direction changes or separate gestures", () => {
    vi.useFakeTimers();
    const host = document.createElement("div"), adjust = vi.fn();
    const dispose = installTerminalFontWheel(host, adjust, () => true);
    const wheel = (deltaY: number) => host.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY }));
    wheel(50); wheel(-50);
    expect(adjust).not.toHaveBeenCalled();
    vi.advanceTimersByTime(301);
    wheel(-50);
    expect(adjust).not.toHaveBeenCalled();
    wheel(-50);
    expect(adjust).toHaveBeenCalledWith(1);
    dispose();
    vi.useRealTimers();
  });
});
