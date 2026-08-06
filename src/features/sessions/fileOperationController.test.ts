import { describe, expect, it, vi } from "vitest";
import {
  createFileOperationController,
  normalizeRemoteEntryName,
} from "./fileOperationController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("文件异步操作控制器", () => {
  it("阻止同类操作重复提交", async () => {
    const request = deferred<void>();
    const controller = createFileOperationController();
    const first = controller.run("move", () => request.promise);

    await expect(controller.run("move", async () => undefined)).resolves.toBe(false);
    request.resolve();
    await expect(first).resolves.toBe(true);
  });

  it("取消和卸载后丢弃旧请求结果", async () => {
    const request = deferred<string>();
    const onSuccess = vi.fn();
    const onPendingChange = vi.fn();
    const controller = createFileOperationController();
    const running = controller.run("inlineRename", () => request.promise, {
      onPendingChange,
      onSuccess,
    });

    controller.cancel("inlineRename");
    request.resolve("旧结果");
    await running;
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenCalledTimes(1);

    controller.dispose();
    await expect(controller.run("dialog", async () => undefined)).resolves.toBe(false);
  });

  it("规范化名称并拒绝空白", () => {
    expect(normalizeRemoteEntryName("  docs  ")).toBe("docs");
    expect(normalizeRemoteEntryName("   ")).toBeNull();
  });
});
