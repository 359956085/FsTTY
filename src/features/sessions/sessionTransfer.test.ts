import { describe, expect, it, vi } from "vitest";
import type { SessionRuntime } from "./useSessionConnections";
import { createRuntime } from "./useSessionConnections";
import { createTransferChannel, fileNameFromPath } from "./sessionTransfer";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));

describe("会话传输运行时", () => {
  it("忽略错误票据事件并按当前票据更新进度", () => {
    let runtime = createRuntime();
    const update = (_sessionId: string, apply: (value: SessionRuntime) => SessionRuntime) => {
      runtime = apply(runtime);
    };
    let current = true;
    const channel = createTransferChannel(
      "session-1",
      "transfer-1",
      "upload",
      "a.txt",
      update,
      () => current,
    );

    channel.onmessage?.({
      kind: "progress",
      transferId: "other",
      transferredBytes: 4,
      totalBytes: 10,
    });
    expect(runtime.transfer?.transferredBytes).toBe(0);
    channel.onmessage?.({
      kind: "completed",
      transferId: "transfer-1",
      transferredBytes: 10,
      totalBytes: 10,
    });
    expect(runtime.transfer?.state).toBe("completed");

    current = false;
    channel.onmessage?.({
      kind: "progress",
      transferId: "transfer-1",
      transferredBytes: 1,
      totalBytes: 10,
    });
    expect(runtime.transfer?.transferredBytes).toBe(10);
  });

  it("创建时已过期不会恢复传输状态", () => {
    let runtime = createRuntime();
    const update = (_sessionId: string, apply: (value: SessionRuntime) => SessionRuntime) => {
      runtime = apply(runtime);
    };

    createTransferChannel("session-1", "transfer-1", "download", "a.txt", update, () => false);

    expect(runtime.transfer).toBeNull();
  });

  it("从 Windows 和 Unix 路径提取文件名", () => {
    expect(fileNameFromPath("C:\\tmp\\a.txt")).toBe("a.txt");
    expect(fileNameFromPath("/tmp/b.txt")).toBe("b.txt");
  });
});
