// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  append: vi.fn<
    (
      token: string,
      runtimeId: string,
      kind: "full" | "viewport",
      chunkIndex: number,
      totalChunks: number,
      data: string,
    ) => Promise<void>
  >(),
  begin: vi.fn(),
  commit: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    abortLightweightMode: mocks.abort,
    appendLightweightSnapshotChunk: mocks.append,
    beginLightweightMode: mocks.begin,
    commitLightweightMode: mocks.commit,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.abort.mockResolvedValue(undefined);
  mocks.append.mockResolvedValue(undefined);
  mocks.begin.mockResolvedValue({ token: "token" });
  mocks.commit.mockResolvedValue(undefined);
});

describe("轻量模式前端事务", () => {
  it("连接或认证未完成时拒绝开始快照", async () => {
    const lightweight = await import("./lightweightMode");
    const unregister = lightweight.registerLightweightTerminal("runtime", {
      cancelPreparation: vi.fn(), capture: vi.fn(), describe: () => null,
      isBlocked: () => true, prepareBarrier: vi.fn(),
    });
    await expect(lightweight.enterLightweightMode(false)).rejects.toThrow("连接、认证");
    expect(mocks.begin).not.toHaveBeenCalled();
    unregister();
  });

  it("准备屏障抛错也解除切换锁", async () => {
    const lightweight = await import("./lightweightMode");
    const cancelPreparation = vi.fn();
    const unregister = lightweight.registerLightweightTerminal("runtime", {
      cancelPreparation, capture: vi.fn(), isBlocked: () => false,
      describe: () => ({ runtimeId: "runtime", currentPath: "/", columns: 80, rows: 24,
        connection: { connectionId: "connection", sessionId: "session", homePath: "/", sftpAvailable: true } }),
      prepareBarrier: () => { throw new Error("初始化失败"); },
    });
    await expect(lightweight.enterLightweightMode(false)).rejects.toThrow("初始化失败");
    expect(lightweight.isLightweightTransitioning()).toBe(false);
    expect(cancelPreparation).toHaveBeenCalledOnce();
    unregister();
  });

  it("恢复完成通知订阅者并将失败标签排除出有效列表", async () => {
    const lightweight = await import("./lightweightMode");
    lightweight.initializeLightweightMode({
      active: true, suppressConfirmation: false, phase: "detached", transferJobs: [],
      terminals: ["good", "failed"].map((runtimeId) => ({ runtimeId, connectionId: runtimeId, sessionId: "session", currentPath: "/" })),
    });
    const notify = vi.fn();
    const unsubscribe = lightweight.subscribeLightweightRestore(notify);
    lightweight.markPreservedTerminalAttached("good");
    lightweight.markPreservedTerminalFailed("failed");
    expect(lightweight.getPreservedRuntimeIds().size).toBe(0);
    expect(lightweight.getValidRestoredRuntimeIds(["good", "failed", "new"])).toEqual(["good", "new"]);
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("先建立屏障并把大快照拆成不超过 192 KiB 的分块", async () => {
    const lightweight = await import("./lightweightMode");
    const order: string[] = [];
    const appendedChunks: Array<{
      kind: "full" | "viewport";
      chunkIndex: number;
      totalChunks: number;
      data: string;
    }> = [];
    mocks.append.mockImplementation(
      async (_token, _runtimeId, kind, chunkIndex, totalChunks, data) => {
        appendedChunks.push({ kind, chunkIndex, totalChunks, data });
      },
    );
    mocks.begin.mockImplementation(async () => {
      order.push("begin");
      return { token: "token" };
    });
    const unregister = lightweight.registerLightweightTerminal("runtime", {
      cancelPreparation: vi.fn(),
      capture: async () => ({
        full: "a".repeat(192 * 1024 + 1),
        viewport: "screen",
      }),
      describe: () => ({
        runtimeId: "runtime",
        connection: {
          connectionId: "connection",
          sessionId: "session",
          homePath: "/home",
          sftpAvailable: true,
        },
        currentPath: "/home",
        columns: 80,
        rows: 24,
      }),
      isBlocked: () => false,
      prepareBarrier: () => order.push("barrier"),
    });

    await lightweight.enterLightweightMode(false);

    expect(order).toEqual(["barrier", "begin"]);
    const fullChunks = appendedChunks.filter((chunk) => chunk.kind === "full");
    expect(fullChunks).toHaveLength(2);
    expect(fullChunks.map((chunk) => [chunk.chunkIndex, chunk.totalChunks])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(
      fullChunks.every(
        (chunk) =>
          Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0))
            .byteLength <=
          192 * 1024,
      ),
    ).toBe(true);
    expect(mocks.commit).toHaveBeenCalledWith("token");
    unregister();
  });

  it("分块失败时中止后端事务并恢复前端通道", async () => {
    const lightweight = await import("./lightweightMode");
    const cancelPreparation = vi.fn();
    mocks.append.mockRejectedValueOnce(new Error("分块失败"));
    const unregister = lightweight.registerLightweightTerminal("runtime", {
      cancelPreparation,
      capture: async () => ({ full: "snapshot", viewport: "screen" }),
      describe: () => ({
        runtimeId: "runtime",
        connection: {
          connectionId: "connection",
          sessionId: "session",
          homePath: "/home",
          sftpAvailable: true,
        },
        currentPath: "/home",
        columns: 80,
        rows: 24,
      }),
      isBlocked: () => false,
      prepareBarrier: vi.fn(),
    });

    await expect(lightweight.enterLightweightMode(false)).rejects.toThrow("分块失败");

    expect(mocks.abort).toHaveBeenCalledWith("token");
    expect(cancelPreparation).toHaveBeenCalledTimes(1);
    expect(lightweight.isLightweightTransitioning()).toBe(false);
    unregister();
  });
});
