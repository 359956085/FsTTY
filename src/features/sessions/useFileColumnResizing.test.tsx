// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileColumnResizing } from "./useFileColumnResizing";

const mocks = vi.hoisted(() => ({ updateWorkspacePreferences: vi.fn() }));

vi.mock("./workspacePreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspacePreferences")>();
  return {
    ...actual,
    readWorkspacePreferences: () => ({
      fileColumns: { name: 140, size: 72, modified: 132, permissions: 96 },
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

afterEach(() => {
  vi.restoreAllMocks();
  mocks.updateWorkspacePreferences.mockReset();
});

describe("useFileColumnResizing", () => {
  it("拖动只在匹配 Pointer 松开时提交", () => {
    const { result } = renderHook(() => useFileColumnResizing());
    const table = document.createElement("div");
    Object.defineProperty(result.current.tableRef, "current", { value: table, writable: true });
    const handle = document.createElement("div");
    const releasePointerCapture = vi.fn();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = releasePointerCapture;
    const start = {
      button: 0,
      clientX: 100,
      currentTarget: handle,
      pointerId: 3,
      preventDefault: vi.fn(),
    } as unknown as ReactPointerEvent<HTMLDivElement>;

    act(() => result.current.beginFileColumnResize("name", start));
    act(() => {
      window.dispatchEvent(pointerEvent("pointercancel", 8, 180));
    });
    expect(releasePointerCapture).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", 3, 180));
    });
    expect(table.style.getPropertyValue("--file-column-name")).toBe("220px");
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", 3, 180));
    });
    expect(mocks.updateWorkspacePreferences).toHaveBeenCalledWith({
      fileColumns: { modified: 132, name: 220, permissions: 96, size: 72 },
    });
  });

  it("失焦取消并恢复宽度，键盘调整受边界约束", () => {
    const { result } = renderHook(() => useFileColumnResizing());
    const table = document.createElement("div");
    Object.defineProperty(result.current.tableRef, "current", { value: table, writable: true });
    const handle = document.createElement("div");
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = vi.fn();
    const start = {
      button: 0,
      clientX: 100,
      currentTarget: handle,
      pointerId: 5,
      preventDefault: vi.fn(),
    } as unknown as ReactPointerEvent<HTMLDivElement>;

    act(() => result.current.beginFileColumnResize("size", start));
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", 5, 140));
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(table.style.getPropertyValue("--file-column-size")).toBe("72px");
    expect(mocks.updateWorkspacePreferences).not.toHaveBeenCalled();

    act(() => result.current.adjustFileColumn("size", -1));
    expect(result.current.fileColumns.size).toBe(64);
    act(() => result.current.adjustFileColumn("size", -1));
    expect(result.current.fileColumns.size).toBe(64);
  });
});
