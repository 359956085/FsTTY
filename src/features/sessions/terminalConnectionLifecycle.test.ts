import { describe, expect, it } from "vitest";
import { createTerminalConnectionLifecycle } from "./terminalConnectionLifecycle";

describe("终端连接生命周期", () => {
  it("阻止重复连接并只接受当前尝试和通道事件", () => {
    const lifecycle = createTerminalConnectionLifecycle<
      { connectionId: string },
      { id: number }
    >();
    const attempt = lifecycle.beginConnect();
    const channel = { id: 1 };

    expect(attempt).toBe(1);
    expect(lifecycle.beginConnect()).toBeNull();
    expect(lifecycle.attachChannel(attempt!, channel)).toBe(true);
    expect(lifecycle.acceptsEvent(attempt!, { id: 1 }, "connection-1")).toBe(false);
    expect(lifecycle.acceptsEvent(attempt!, channel, "connection-1")).toBe(true);
    expect(lifecycle.setConnection(attempt!, { connectionId: "connection-1" })).toBe(true);
    expect(lifecycle.acceptsEvent(attempt!, channel, "connection-2")).toBe(false);
  });

  it("取消后拒绝旧结果，卸载返回待断开的活动连接", () => {
    const lifecycle = createTerminalConnectionLifecycle<
      { connectionId: string },
      object
    >();
    const first = lifecycle.beginConnect()!;
    lifecycle.cancel();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.setConnection(first, { connectionId: "stale" })).toBe(false);

    const second = lifecycle.beginConnect()!;
    expect(lifecycle.setConnection(second, { connectionId: "active" })).toBe(true);
    expect(lifecycle.dispose()).toEqual({ connectionId: "active" });
    expect(lifecycle.canConnect()).toBe(false);
    expect(lifecycle.dispose()).toBeNull();
  });

  it("StrictMode 重放后使用新实例连接，旧实例继续保持销毁", () => {
    const first = createTerminalConnectionLifecycle<
      { connectionId: string },
      object
    >();
    first.dispose();

    const second = createTerminalConnectionLifecycle<
      { connectionId: string },
      object
    >();

    expect(first.canConnect()).toBe(false);
    expect(first.beginConnect()).toBeNull();
    expect(second.canConnect()).toBe(true);
    expect(second.beginConnect()).toBe(1);
    expect(second.beginConnect()).toBeNull();
  });
});
