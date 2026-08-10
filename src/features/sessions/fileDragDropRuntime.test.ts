// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installFileDragDropRuntime } from "./fileDragDropRuntime";

const mocks = vi.hoisted(() => ({
  dragCallback: null as null | ((event: { payload: Record<string, unknown> }) => void),
  scaleCallback: null as null | ((event: { payload: { scaleFactor: number } }) => void),
  removeDrag: vi.fn(),
  removeScale: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (callback: (event: { payload: Record<string, unknown> }) => void) => {
      mocks.dragCallback = callback;
      return mocks.removeDrag;
    }),
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: vi.fn().mockResolvedValue(1),
    onScaleChanged: vi.fn(async (callback: (event: { payload: { scaleFactor: number } }) => void) => {
      mocks.scaleCallback = callback;
      return mocks.removeScale;
    }),
  }),
}));

async function flushRuntime() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  mocks.dragCallback = null;
  mocks.scaleCallback = null;
  mocks.removeDrag.mockReset();
  mocks.removeScale.mockReset();
});

describe("fileDragDropRuntime", () => {
  it("按最新缩放命中面板并上传", async () => {
    const onUploadFiles = vi.fn();
    const onActiveChange = vi.fn();
    const panel = document.createElement("section");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    const runtime = installFileDragDropRuntime({
      getDragUploadState: () => ({ enabled: true, onUploadFiles }),
      getPanel: () => panel,
      onActiveChange,
      onWindowBlur: vi.fn(),
    });
    await flushRuntime();
    mocks.scaleCallback?.({ payload: { scaleFactor: 2 } });
    const toLogical = vi.fn().mockReturnValue({ x: 100, y: 100 });
    mocks.dragCallback?.({
      payload: { paths: ["C:\\demo.txt"], position: { toLogical }, type: "drop" },
    });

    expect(toLogical).toHaveBeenCalledWith(2);
    expect(onUploadFiles).toHaveBeenCalledWith(["C:\\demo.txt"]);
    runtime.dispose();
  });

  it("dispose 清理监听且旧实例不再产生副作用", async () => {
    const onActiveChange = vi.fn();
    const onWindowBlur = vi.fn();
    const runtime = installFileDragDropRuntime({
      getDragUploadState: () => ({ enabled: true, onUploadFiles: vi.fn() }),
      getPanel: () => null,
      onActiveChange,
      onWindowBlur,
    });
    await flushRuntime();
    const oldDragCallback = mocks.dragCallback;
    runtime.dispose();
    window.dispatchEvent(new Event("blur"));
    oldDragCallback?.({ payload: { type: "leave" } });

    expect(mocks.removeDrag).toHaveBeenCalledTimes(1);
    expect(mocks.removeScale).toHaveBeenCalledTimes(1);
    expect(onWindowBlur).not.toHaveBeenCalled();
    expect(onActiveChange).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });
});
