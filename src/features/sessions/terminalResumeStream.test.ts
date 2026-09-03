// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { TerminalResumeEvent } from "../../shared/api/types";
import { createTerminalResumeStream } from "./terminalResumeStream";

const snapshot = (data = "screen"): TerminalResumeEvent => ({
  kind: "snapshot", connectionId: "connection", data: btoa(data),
  chunkIndex: 0, totalChunks: 1, truncated: false,
});
const ready: TerminalResumeEvent = {
  kind: "ready", connectionId: "connection", truncated: false,
};

function setup() {
  const writes: string[] = [];
  const drains: Array<() => void> = [];
  const current = { value: true };
  const onEnd = vi.fn();
  const consumeBarrier = vi.fn((data: string) => data === "");
  const stream = createTerminalResumeStream({
    connectionId: "connection",
    isCurrent: () => current.value,
    write: (data, callback) => {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (callback) drains.push(callback);
    },
    consumeBarrier,
    onEnd,
  });
  return { stream, writes, drains, current, onEnd, consumeBarrier };
}

describe("保活终端恢复流", () => {
  it("尺寸初始化前缓存事件，快照和增量排空后才就绪", async () => {
    const { stream, writes, drains } = setup();
    stream.push(snapshot());
    stream.push({ kind: "data", connectionId: "connection", data: btoa("delta") });
    stream.push(ready);
    expect(writes).toEqual([]);
    stream.start();
    expect(writes).toEqual(["screen", "delta", ""]);
    const resolved = vi.fn();
    void stream.ready.then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    drains[0]?.();
    await expect(stream.ready).resolves.toBe(false);
  });

  it("恢复后仍处理断线，旧通道和错误连接事件均被隔离", async () => {
    const { stream, writes, drains, onEnd } = setup();
    stream.start();
    stream.push({ ...snapshot("other"), connectionId: "other" });
    stream.push(snapshot());
    stream.push(ready);
    drains[0]?.();
    await stream.ready;
    stream.push({ kind: "disconnected", connectionId: "connection", message: "closed" });
    stream.push({ kind: "data", connectionId: "connection", data: btoa("late") });
    expect(onEnd).toHaveBeenCalledOnce();
    expect(writes).toEqual(["screen", ""]);
  });

  it("重放中的断线墓碑等待屏幕排空后显示", async () => {
    const { stream, drains, onEnd } = setup();
    stream.start();
    stream.push(snapshot());
    stream.push({ kind: "error", connectionId: "connection", message: "closed" });
    stream.push(ready);
    expect(onEnd).not.toHaveBeenCalled();
    drains[0]?.();
    await stream.ready;
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ message: "closed" }));
  });

  it("卸载或重连后不应用迟到数据和排空回调", async () => {
    const { stream, writes, drains, current, onEnd } = setup();
    stream.start();
    stream.push(snapshot());
    stream.push(ready);
    current.value = false;
    stream.push({ kind: "data", connectionId: "connection", data: btoa("late") });
    drains[0]?.();
    stream.dispose();
    await expect(stream.ready).rejects.toThrow("终端恢复已取消");
    expect(writes).toEqual(["screen", ""]);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("拒绝乱序、过多分块和缺失快照的就绪标记", async () => {
    for (const event of [
      { ...snapshot(), chunkIndex: 1 },
      { ...snapshot(), totalChunks: 1000 },
      ready,
    ] as TerminalResumeEvent[]) {
      const { stream } = setup();
      stream.start();
      stream.push(event);
      await expect(stream.ready).rejects.toThrow(/快照/);
    }
  });

  it("恢复后的零长度事件继续充当下一次快照屏障", async () => {
    const { stream, writes, drains, consumeBarrier } = setup();
    stream.start();
    stream.push(snapshot());
    stream.push(ready);
    drains[0]?.();
    await stream.ready;
    stream.push({ kind: "data", connectionId: "connection", data: "" });
    expect(consumeBarrier).toHaveBeenCalledWith("");
    expect(writes).toEqual(["screen", ""]);
  });
});
