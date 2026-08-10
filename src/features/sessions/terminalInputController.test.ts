// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalInputController } from "./terminalInputController";

afterEach(() => vi.useRealTimers());

describe("终端输入控制器", () => {
  it("在一帧内合并输入并串行写入", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = createTerminalInputController({
      getConnectionId: () => "connection-1",
      isConnecting: () => false,
      onWriteError: vi.fn(),
      write,
    });

    controller.enqueue("a");
    controller.enqueue("b");
    expect(write).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("connection-1", "ab");
  });

  it("连接完成后发送握手期间缓存的终端应答", async () => {
    let connectionId: string | null = null;
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = createTerminalInputController({
      getConnectionId: () => connectionId,
      isConnecting: () => true,
      onWriteError: vi.fn(),
      write,
    });

    controller.enqueue("terminal-response");
    connectionId = "connection-1";
    controller.flush();
    await Promise.resolve();

    expect(write).toHaveBeenCalledWith("connection-1", "terminal-response");
  });

  it("连接切换后不写入旧连接", async () => {
    vi.useFakeTimers();
    let connectionId = "connection-1";
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = createTerminalInputController({
      getConnectionId: () => connectionId,
      isConnecting: () => false,
      onWriteError: vi.fn(),
      write,
    });

    controller.enqueue("old");
    connectionId = "connection-2";
    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
  });

  it("卸载后取消定时写入", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = createTerminalInputController({
      getConnectionId: () => "connection-1",
      isConnecting: () => false,
      onWriteError: vi.fn(),
      write,
    });

    controller.enqueue("pending");
    controller.dispose();
    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
  });
});
