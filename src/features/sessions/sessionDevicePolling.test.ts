import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceMetricsSnapshot, DeviceStatus, SshConnection } from "../../shared/api/types";
import type { DeviceMetricSample } from "./deviceMetrics";
import { createSessionDevicePollingController } from "./sessionDevicePolling";

interface Runtime {
  connection: SshConnection | null;
  deviceLoading: boolean;
  deviceStatus: DeviceStatus | null;
  deviceHistory: DeviceMetricSample[];
  deviceWindowEndMs: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function snapshot(connectionId = "connection-1", windowEndMs = 10_000): DeviceMetricsSnapshot {
  return {
    connectionId,
    status: { sessionId: "session", available: true, cpuPercent: 20 },
    history: [{
      sampledAtMs: windowEndMs,
      cpuPercent: 20,
      memoryPercent: 40,
      networkDownloadBytesPerSecond: 100,
      networkUploadBytesPerSecond: 50,
    }],
    windowEndMs,
  };
}

function emptySnapshot(windowEndMs = 0, connectionId = "connection-1"): DeviceMetricsSnapshot {
  return { connectionId, status: null, history: [], windowEndMs };
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
      deviceLoading: false,
      deviceStatus: null,
      deviceHistory: [],
      deviceWindowEndMs: 0,
    },
  };
  const getDeviceMetricsSnapshot = vi.fn<(connectionId: string) => Promise<DeviceMetricsSnapshot>>();
  const controller = createSessionDevicePollingController<Runtime>({
    getDeviceMetricsSnapshot,
    getRuntime: (sessionId) => runtimes[sessionId],
    intervalMs: 5_000,
    updateRuntime: (sessionId, update) => {
      const runtime = runtimes[sessionId];
      if (runtime) runtimes[sessionId] = update(runtime);
    },
  });
  return { controller, getDeviceMetricsSnapshot, runtimes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("设备轮询控制器", () => {
  it("首次空缓存每 250 毫秒重读，拿到数据后恢复 5 秒刷新", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    let cached = emptySnapshot();
    getDeviceMetricsSnapshot.mockImplementation(async () => cached);
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(249);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    expect(runtimes.session.deviceLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(150);
    cached = snapshot("connection-1", 400);
    await vi.advanceTimersByTimeAsync(99);
    expect(runtimes.session.deviceStatus).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(3);
    expect(runtimes.session.deviceLoading).toBe(false);
    expect(runtimes.session.deviceHistory).toEqual(cached.history);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(4);
    controller.dispose();
  });

  it.each(["失败断点", "不可用状态"])("首轮返回%s也结束快速读取", async (kind) => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const failed = emptySnapshot(100);
    if (kind === "失败断点") {
      failed.history.push({
        sampledAtMs: 100,
        cpuPercent: null,
        memoryPercent: null,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      });
    } else {
      failed.status = { sessionId: "session", available: false };
    }
    getDeviceMetricsSnapshot.mockResolvedValue(failed);
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimes.session.deviceLoading).toBe(false);
    expect(runtimes.session.deviceHistory).toEqual(failed.history);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("首屏 IPC 临时失败仍快速读取缓存并恢复", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const ready = snapshot("connection-1", 500);
    getDeviceMetricsSnapshot.mockRejectedValueOnce(new Error("缓存暂不可读"))
      .mockResolvedValueOnce(emptySnapshot(250))
      .mockResolvedValue(ready);
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(250);
    expect(runtimes.session.deviceLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(3);
    expect(runtimes.session.deviceLoading).toBe(false);
    expect(runtimes.session.deviceHistory).toEqual(ready.history);
    controller.dispose();
  });

  it.each(["空缓存", "IPC 连续失败"])("%s超过 10 秒退出加载态，正常刷新仍可恢复", async (kind) => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    if (kind === "空缓存") getDeviceMetricsSnapshot.mockResolvedValue(emptySnapshot());
    else getDeviceMetricsSnapshot.mockRejectedValue(new Error("缓存暂不可读"));
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runtimes.session.deviceLoading).toBe(true);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(40);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtimes.session.deviceLoading).toBe(false);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(41);
    const ready = snapshot("connection-1", 15_000);
    getDeviceMetricsSnapshot.mockResolvedValue(ready);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(41);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(42);
    expect(runtimes.session.deviceHistory).toEqual(ready.history);
    expect(runtimes.session.deviceLoading).toBe(false);
    controller.dispose();
  });

  it("请求超过首屏等待期限仍保持串行，不因超时叠加 IPC", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const pending = deferred<DeviceMetricsSnapshot>();
    getDeviceMetricsSnapshot.mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot());
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtimes.session.deviceLoading).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimes.session.deviceStatus).toEqual(snapshot().status);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("重连后旧请求和旧超时回调都不能结束新连接加载态", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const oldRequest = deferred<DeviceMetricsSnapshot>();
    const newRequest = deferred<DeviceMetricsSnapshot>();
    getDeviceMetricsSnapshot.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    controller.start("session", "connection-1");
    const lateTimeout = timer.mock.calls.find(([, delay]) => delay === 10_000)![0] as () => void;
    runtimes.session.connection = { ...runtimes.session.connection!, connectionId: "connection-2" };
    controller.start("session", "connection-2");
    oldRequest.resolve(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    lateTimeout();
    expect(runtimes.session.deviceLoading).toBe(true);
    expect(runtimes.session.deviceStatus).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    newRequest.resolve(snapshot("connection-2", 500));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimes.session.deviceLoading).toBe(false);
    expect(runtimes.session.deviceWindowEndMs).toBe(500);
    controller.dispose();
  });

  it("首个缓存响应早于 React 提交连接状态也不会丢失", async () => {
    const { runtimes } = createHarness();
    const connection = runtimes.session.connection;
    runtimes.session.connection = null;
    const updates: Array<(runtime: Runtime) => Runtime> = [];
    const controller = createSessionDevicePollingController<Runtime>({
      getDeviceMetricsSnapshot: async () => snapshot(),
      getRuntime: () => runtimes.session,
      intervalMs: 5_000,
      updateRuntime: (_, update) => updates.push(update),
    });
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(0);
    runtimes.session.connection = connection;
    for (const update of updates) runtimes.session = update(runtimes.session);
    expect(runtimes.session.deviceHistory).toEqual(snapshot().history);
    expect(runtimes.session.deviceLoading).toBe(false);
    controller.dispose();
  });

  it("已有曲线再次挂接时不进入加载态，空缓存不清空已有数据", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const ready = snapshot();
    getDeviceMetricsSnapshot.mockResolvedValueOnce(ready).mockResolvedValue(emptySnapshot(20_000));
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(0);
    controller.start("session", "connection-1");
    expect(runtimes.session.deviceLoading).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimes.session.deviceHistory).toEqual(ready.history);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("取消时丢弃进行中响应且不再安排轮询", async () => {
    const pending = deferred<DeviceMetricsSnapshot>();
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    getDeviceMetricsSnapshot.mockReturnValueOnce(pending.promise);
    controller.start("session", "connection-1");
    controller.cancelSession("session");
    pending.resolve(snapshot());
    await vi.runAllTimersAsync();

    expect(runtimes.session.deviceStatus).toBeNull();
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("连接替换后旧响应不能覆盖新状态", async () => {
    const oldRequest = deferred<DeviceMetricsSnapshot>();
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    getDeviceMetricsSnapshot.mockReturnValueOnce(oldRequest.promise);
    controller.start("session", "connection-1");
    runtimes.session.connection = {
      ...runtimes.session.connection!,
      connectionId: "connection-2",
    };
    const restored = snapshot("connection-2", 5_000);
    getDeviceMetricsSnapshot.mockResolvedValueOnce(restored);
    controller.start("session", "connection-2");
    await Promise.resolve();
    oldRequest.resolve(snapshot());
    await Promise.resolve();

    expect(runtimes.session.deviceHistory).toEqual(restored.history);
    expect(runtimes.session.deviceWindowEndMs).toBe(restored.windowEndMs);
    controller.dispose();
  });

  it.each(["removeSession", "dispose"] as const)("%s 清理轮询", async (method) => {
    const { controller, getDeviceMetricsSnapshot } = createHarness();
    getDeviceMetricsSnapshot.mockResolvedValue(snapshot());
    controller.start("session", "connection-1");
    await Promise.resolve();

    if (method === "dispose") controller.dispose();
    else controller.removeSession("session");
    await vi.runAllTimersAsync();

    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 式清理重建只保留新轮询", async () => {
    const { controller, getDeviceMetricsSnapshot } = createHarness();
    getDeviceMetricsSnapshot.mockResolvedValue(snapshot());
    controller.dispose();
    controller.activate();
    controller.start("session", "connection-1");
    await Promise.resolve();
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);

    controller.dispose();
    await vi.runAllTimersAsync();
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("恢复时立即应用后台历史，重复读取不会追加重复点", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const restored = snapshot("connection-1", 900_000);
    restored.history.unshift({ ...restored.history[0], sampledAtMs: 895_000 });
    getDeviceMetricsSnapshot.mockResolvedValue(restored);
    controller.start("session", "connection-1");
    await Promise.resolve();
    expect(runtimes.session.deviceHistory).toEqual(restored.history);
    expect(runtimes.session.deviceWindowEndMs).toBe(900_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runtimes.session.deviceHistory).toHaveLength(2);
    controller.dispose();
  });

  it("连接编号不匹配的快照被丢弃", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    getDeviceMetricsSnapshot.mockResolvedValue(snapshot("other"));
    controller.start("session", "connection-1");
    await Promise.resolve();
    expect(runtimes.session.deviceHistory).toEqual([]);
    expect(runtimes.session.deviceWindowEndMs).toBe(0);
    expect(runtimes.session.deviceLoading).toBe(true);
    controller.dispose();
  });

  it("卸载重建后旧请求不能覆盖新快照", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const pending = deferred<DeviceMetricsSnapshot>();
    getDeviceMetricsSnapshot.mockReturnValueOnce(pending.promise);
    controller.start("session", "connection-1");
    controller.dispose();
    controller.activate();
    const restored = snapshot("connection-1", 30_000);
    getDeviceMetricsSnapshot.mockResolvedValue(restored);
    controller.start("session", "connection-1");
    await Promise.resolve();
    pending.resolve(snapshot("connection-1", 90_000));
    await Promise.resolve();
    expect(runtimes.session.deviceHistory).toEqual(restored.history);
    controller.dispose();
  });

  it("读取失败保留旧快照，下轮可恢复，后台时间不倒退", async () => {
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    const first = snapshot("connection-1", 10_000);
    const latest = snapshot("connection-1", 30_000);
    getDeviceMetricsSnapshot.mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockResolvedValueOnce(latest)
      .mockResolvedValue(snapshot("connection-1", 20_000));
    controller.start("session", "connection-1");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtimes.session.deviceHistory).toEqual(first.history);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtimes.session.deviceHistory).toEqual(latest.history);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtimes.session.deviceWindowEndMs).toBe(30_000);
    controller.dispose();
  });

  it("状态更新排队期间断开也不会写回快照", async () => {
    const { runtimes } = createHarness();
    const updates: Array<(runtime: Runtime) => Runtime> = [];
    const controller = createSessionDevicePollingController<Runtime>({
      getDeviceMetricsSnapshot: async () => snapshot(),
      getRuntime: () => runtimes.session,
      intervalMs: 5_000,
      updateRuntime: (_, update) => updates.push(update),
    });
    controller.start("session", "connection-1");
    await Promise.resolve();
    controller.cancelSession("session");
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update(runtimes.session)).toBe(runtimes.session);
    controller.dispose();
  });

  it("旧连接已排队的定时回调不能取消新连接刷新", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { controller, getDeviceMetricsSnapshot, runtimes } = createHarness();
    getDeviceMetricsSnapshot.mockImplementation(async (connectionId) => snapshot(connectionId));
    controller.start("session", "connection-1");
    await vi.advanceTimersByTimeAsync(0);
    const lateTimer = timer.mock.calls.find(([, delay]) => delay === 5_000)![0] as () => void;
    runtimes.session.connection = { ...runtimes.session.connection!, connectionId: "connection-2" };
    controller.start("session", "connection-2");
    await vi.advanceTimersByTimeAsync(0);
    lateTimer();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getDeviceMetricsSnapshot).toHaveBeenCalledTimes(3);
    expect(getDeviceMetricsSnapshot).toHaveBeenLastCalledWith("connection-2");
    controller.dispose();
  });
});
