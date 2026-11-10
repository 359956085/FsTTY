import { describe, expect, it, vi, type Mock } from "vitest";
import { syncTerminalActivity, type TerminalActivityController } from "./terminalActivity";

function activity(): TerminalActivityController & {
  start: Mock<() => void>;
  stop: Mock<() => void>;
} {
  return {
    start: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
  };
}

describe("syncTerminalActivity", () => {
  it("只为可见活动连接启动全部监听", () => {
    const resizeObserver = activity();
    const remoteMouse = activity();

    expect(
      syncTerminalActivity({
        active: true,
        connected: true,
        resizeObserver,
        remoteMouse,
        visible: true,
      }),
    ).toEqual({ shouldFit: true, shouldResetInteraction: false });
    expect(resizeObserver.start).toHaveBeenCalledOnce();
    expect(remoteMouse.start).toHaveBeenCalledOnce();
  });

  it("隐藏后停止监听并要求清理交互", () => {
    const resizeObserver = activity();
    const remoteMouse = activity();

    expect(
      syncTerminalActivity({
        active: false,
        connected: true,
        resizeObserver,
        remoteMouse,
        visible: true,
      }),
    ).toEqual({ shouldFit: false, shouldResetInteraction: true });
    expect(resizeObserver.stop).toHaveBeenCalledOnce();
    expect(remoteMouse.stop).toHaveBeenCalledOnce();
  });
});
