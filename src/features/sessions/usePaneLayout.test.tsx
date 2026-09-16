// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneLayout } from "./usePaneLayout";

const mocks = vi.hoisted(() => ({
  updateWorkspacePreferences: vi.fn(),
  layout: { leftWidth: 260, rightWidth: 460, leftCollapsed: false, rightCollapsed: false },
}));

vi.mock("./workspacePreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspacePreferences")>();
  return {
    ...actual,
    readWorkspacePreferences: () => ({
      layout: { ...mocks.layout },
    }),
    updateWorkspacePreferences: mocks.updateWorkspacePreferences,
  };
});

function pointerEvent(type: string, pointerId: number, clientX: number) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
  });
  return event;
}

function installRoot(result: ReturnType<typeof renderHook<ReturnType<typeof usePaneLayout>, void>>["result"], width = 1400) {
  const root = document.createElement("div");
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
    bottom: 800,
    height: 800,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  });
  Object.defineProperty(result.current.rootRef, "current", { value: root, writable: true });
  return root;
}

function resizeEvent(handle: HTMLDivElement, pointerId: number, clientX: number) {
  return {
    button: 0,
    clientX,
    currentTarget: handle,
    pointerId,
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.updateWorkspacePreferences.mockReset();
});

beforeEach(() => {
  mocks.layout = { leftWidth: 260, rightWidth: 460, leftCollapsed: false, rightCollapsed: false };
});

describe("usePaneLayout", () => {
  it("恢复旧收起偏好并保留宽度，两侧可分别展开", () => {
    mocks.layout = { leftWidth: 300, rightWidth: 480, leftCollapsed: true, rightCollapsed: true };
    const { result } = renderHook(() => usePaneLayout());
    installRoot(result);
    expect(result.current.layout).toEqual(mocks.layout);
    act(() => result.current.toggleLeftCollapsed());
    expect(result.current.layout).toEqual({ ...mocks.layout, leftCollapsed: false });
    act(() => result.current.toggleRightCollapsed());
    expect(result.current.layout).toEqual({ ...mocks.layout, leftCollapsed: false, rightCollapsed: false });
    act(() => { result.current.toggleLeftCollapsed(); result.current.toggleRightCollapsed(); });
    expect(result.current.layout).toEqual(mocks.layout);
  });

  it("收起右侧后不再为占位栏或其手柄预留宽度", () => {
    mocks.layout.rightCollapsed = true;
    const { result } = renderHook(() => usePaneLayout());
    installRoot(result, 800);
    act(() => {
      for (let index = 0; index < 30; index += 1) result.current.adjustResize("left", 1);
    });
    expect(result.current.layout.leftWidth).toBe(356);
    expect(result.current.layout.rightWidth).toBe(460);
  });

  it("收起左侧时右侧拖动按单个手柄计算边界", () => {
    mocks.layout.leftCollapsed = true;
    const { result } = renderHook(() => usePaneLayout());
    installRoot(result, 1180);
    act(() => {
      for (let index = 0; index < 50; index += 1) result.current.adjustResize("right", -1);
    });
    expect(result.current.layout.rightWidth).toBe(736);
  });

  it("窄窗口展开时收缩面板，保证终端最小宽度", () => {
    mocks.layout = { leftWidth: 420, rightWidth: 600, leftCollapsed: true, rightCollapsed: false };
    const { result } = renderHook(() => usePaneLayout());
    installRoot(result, 1180);
    act(() => result.current.toggleLeftCollapsed());
    const layout = result.current.layout;
    expect(layout.leftCollapsed).toBe(false);
    expect(layout.leftWidth + layout.rightWidth + 8 + 440).toBe(1180);
    expect(layout.leftWidth).toBeGreaterThanOrEqual(220);
    expect(layout.rightWidth).toBeGreaterThanOrEqual(360);
  });
  it("忽略错误 Pointer，并在正确释放后持久化", () => {
    const { result } = renderHook(() => usePaneLayout());
    installRoot(result);
    const handle = document.createElement("div");
    const releasePointerCapture = vi.fn();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = releasePointerCapture;

    act(() => result.current.beginResize("left", resizeEvent(handle, 7, 100)));
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", 8, 180));
    });
    expect(mocks.updateWorkspacePreferences).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", 7, 180));
    });
    expect(mocks.updateWorkspacePreferences).toHaveBeenCalledWith({
      layout: {
        leftCollapsed: false,
        leftWidth: 340,
        rightCollapsed: false,
        rightWidth: 460,
      },
    });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("错误 Pointer 取消不终止拖动，失焦恢复原宽度", () => {
    const { result } = renderHook(() => usePaneLayout());
    const root = installRoot(result);
    const handle = document.createElement("div");
    const releasePointerCapture = vi.fn();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = releasePointerCapture;

    act(() => result.current.beginResize("right", resizeEvent(handle, 4, 500)));
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", 4, 450));
    });
    expect(root.style.getPropertyValue("--workspace-right-width")).toBe("510px");
    act(() => {
      window.dispatchEvent(pointerEvent("pointercancel", 9, 450));
    });
    expect(releasePointerCapture).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(root.style.getPropertyValue("--workspace-right-width")).toBe("460px");
    expect(releasePointerCapture).toHaveBeenCalledWith(4);
  });

  it("键盘调整遵守方向语义和边界", () => {
    const { result } = renderHook(() => usePaneLayout());
    installRoot(result);
    act(() => result.current.adjustResize("right", 1));
    expect(result.current.layout.rightWidth).toBe(452);
    act(() => result.current.adjustResize("left", 1));
    expect(result.current.layout.leftWidth).toBe(268);
  });
});
