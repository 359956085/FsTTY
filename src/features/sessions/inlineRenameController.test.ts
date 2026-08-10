import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../shared/api/types";
import { createInlineRenameController } from "./inlineRenameController";

const file: FileEntry = {
  group: "root",
  kind: "file",
  name: "notes.txt",
  owner: "root",
  path: "/srv/notes.txt",
  permissions: "-rw-r--r--",
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("inlineRenameController", () => {
  it("慢速二次点击触发重命名，快速双击不触发", () => {
    const controller = createInlineRenameController({
      onChange: vi.fn(),
      onFocusRequested: vi.fn(),
      onPendingChange: vi.fn(),
    });
    expect(
      controller.registerNameClick(file, file.path, { path: file.path, timeMs: 100 }, 1, false),
    ).toBe(false);
    expect(
      controller.registerNameClick(file, file.path, { path: file.path, timeMs: 500 }, 1, false),
    ).toBe(true);
    expect(
      controller.registerNameClick(file, file.path, { path: file.path, timeMs: 600 }, 2, false),
    ).toBe(false);
  });

  it("重复提交被拦截，路径切换后旧失败不恢复编辑框", async () => {
    const onChange = vi.fn();
    const operation = deferred();
    const rename = vi.fn().mockReturnValue(operation.promise);
    const controller = createInlineRenameController({
      onChange,
      onFocusRequested: vi.fn(),
      onPendingChange: vi.fn(),
    });
    controller.begin(file);
    controller.update("renamed.txt");
    const first = controller.submit({
      formatError: () => "failed",
      rename,
      requiredError: "required",
    });
    await controller.submit({
      formatError: () => "failed",
      rename,
      requiredError: "required",
    });
    expect(rename).toHaveBeenCalledTimes(1);

    controller.cancel();
    operation.reject(new Error("late"));
    await first;
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("非法名称显示错误，卸载后忽略成功结果", async () => {
    const onChange = vi.fn();
    const onFocusRequested = vi.fn();
    const operation = deferred();
    const controller = createInlineRenameController({
      onChange,
      onFocusRequested,
      onPendingChange: vi.fn(),
    });
    controller.begin(file);
    controller.update("  ");
    await controller.submit({
      formatError: () => "failed",
      rename: vi.fn(),
      requiredError: "required",
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ error: "required" }));
    expect(onFocusRequested).toHaveBeenCalledTimes(1);

    controller.update("renamed.txt");
    const submit = controller.submit({
      formatError: () => "failed",
      rename: () => operation.promise,
      requiredError: "required",
    });
    controller.dispose();
    operation.resolve();
    await submit;
    expect(onChange).not.toHaveBeenLastCalledWith(null);
  });
});
