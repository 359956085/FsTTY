import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../shared/api/types";
import { createRemoteEntryDragController } from "./remoteEntryDrag";

const source: FileEntry = {
  kind: "file",
  modifiedAt: null,
  name: "report.txt",
  owner: "root",
  group: "root",
  path: "/report.txt",
  permissions: "rw-r--r--",
  size: 12,
};

function captureTarget() {
  let captured: number | null = null;
  return {
    hasPointerCapture: vi.fn((pointerId: number) => captured === pointerId),
    releasePointerCapture: vi.fn((pointerId: number) => {
      if (captured === pointerId) captured = null;
    }),
    setPointerCapture: vi.fn((pointerId: number) => {
      captured = pointerId;
    }),
  };
}

describe("远端文件拖动控制器", () => {
  it("超过阈值后提交目标并释放 Pointer Capture", () => {
    const onChange = vi.fn();
    const target = captureTarget();
    const controller = createRemoteEntryDragController({ onChange });

    controller.begin({ captureTarget: target, clientX: 10, clientY: 10, pointerId: 7, source });
    expect(
      controller.move({ clientX: 13, clientY: 13, pointerId: 7, targetDirectory: "/tmp" }),
    ).toEqual({ active: false, started: false });
    expect(
      controller.move({ clientX: 20, clientY: 10, pointerId: 7, targetDirectory: "/tmp" }),
    ).toEqual({ active: true, started: true });
    expect(controller.finish(7)).toEqual({
      move: { source, targetDirectory: "/tmp" },
      suppressClick: true,
    });
    expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("忽略错误 Pointer，并在取消和卸载时完整清理", () => {
    const onChange = vi.fn();
    const target = captureTarget();
    const controller = createRemoteEntryDragController({ onChange });

    controller.begin({ captureTarget: target, clientX: 0, clientY: 0, pointerId: 3, source });
    expect(
      controller.move({ clientX: 20, clientY: 0, pointerId: 4, targetDirectory: "/tmp" }),
    ).toEqual({ active: false, started: false });
    expect(controller.cancel(4)).toBe(false);
    expect(controller.cancel(3)).toBe(true);

    controller.begin({ captureTarget: target, clientX: 0, clientY: 0, pointerId: 5, source });
    controller.dispose();
    expect(target.releasePointerCapture).toHaveBeenCalledWith(5);
    expect(controller.finish(5)).toEqual({ move: null, suppressClick: false });
  });
});
