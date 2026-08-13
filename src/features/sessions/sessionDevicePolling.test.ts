import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceStatus, SshConnection } from "../../shared/api/types";
import type { DeviceMetricSample } from "./deviceMetrics";
import { createSessionDevicePollingController } from "./sessionDevicePolling";

interface Runtime {
  connection: SshConnection | null;
  deviceStatus: DeviceStatus | null;
  deviceHistory: DeviceMetricSample[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function status(sessionId: string): DeviceStatus {
  return { sessionId, available: true, cpuPercent: 20 };
}

function createHarness() {
  const runtimes: Record<string, Runtime> = {
    session: {
      connection: {
        connectionId: "connection-1",
        sessionId: "session",
        homePath: "/home",
        sftpAvailable: true,
      },
      deviceStatus: null,
      deviceHistory: [],
    },
  };
  const getDeviceStatus = vi.fn<(connectionId: string) => Promise<DeviceStatus>>();
  const controller = createSessionDevicePollingController<Runtime>({
    getDeviceStatus,
    getRuntime: (sessionId) => runtimes[sessionId],
    intervalMs: 5_000,
    now: () => 10_000,
    updateRuntime: (sessionId, update) => {
      const runtime = runtimes[sessionId];
      if (runtime) runtimes[sessionId] = update(runtime);
    },
  });
  return { controller, getDeviceStatus, runtimes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("设备轮询控制器", () => {
  it("取消时丢弃进行中响应且不再安排轮询", async () => {
    const pending = deferred<DeviceStatus>();
    const { controller, getDeviceStatus, runtimes } = createHarness();
    getDeviceStatus.mockReturnValueOnce(pending.promise);
    controller.start("session", "connection-1");
    controller.cancelSession("session");
    pending.resolve(status("session"));
    await vi.runAllTimersAsync();

    expect(runtimes.session.deviceStatus).toBeNull();
    expect(getDeviceStatus).toHaveBeenCalledTimes(1);
  });

  it("连接替换后旧响应不能覆盖新状态", async () => {
    const oldRequest = deferred<DeviceStatus>();
    const { controller, getDeviceStatus, runtimes } = createHarness();
    getDeviceStatus.mockReturnValueOnce(oldRequest.promise);
    controller.start("session", "connection-1");
    runtimes.session.connection = {
      ...runtimes.session.connection!,
      connectionId: "connection-2",
    };
    getDeviceStatus.mockResolvedValueOnce(status("new"));
    controller.start("session", "connection-2");
    await Promise.resolve();
    oldRequest.resolve(status("old"));
    await Promise.resolve();

    expect(runtimes.session.deviceStatus?.sessionId).toBe("new");
    controller.dispose();
  });

  it.each(["removeSession", "dispose"] as const)("%s 清理轮询", async (method) => {
    const { controller, getDeviceStatus } = createHarness();
    getDeviceStatus.mockResolvedValue(status("session"));
    controller.start("session", "connection-1");
    await Promise.resolve();

    if (method === "dispose") controller.dispose();
    else controller.removeSession("session");
    await vi.runAllTimersAsync();

    expect(getDeviceStatus).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 式清理重建只保留新轮询", async () => {
    const { controller, getDeviceStatus } = createHarness();
    getDeviceStatus.mockResolvedValue(status("session"));
    controller.dispose();
    controller.activate();
    controller.start("session", "connection-1");
    await Promise.resolve();
    expect(getDeviceStatus).toHaveBeenCalledTimes(1);

    controller.dispose();
    await vi.runAllTimersAsync();
    expect(getDeviceStatus).toHaveBeenCalledTimes(1);
  });
});
