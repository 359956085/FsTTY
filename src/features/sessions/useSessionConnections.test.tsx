// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceMetricsSnapshot,
  DeviceStatus,
  FileEntry,
  SshConnection,
  StartTransferJobRequest,
  TransferJobEvent,
  TransferJobState,
  TransferJobSummary,
} from "../../shared/api/types";
import { initializeLightweightMode } from "../lightweight/lightweightMode";
import { useSessionConnections } from "./useSessionConnections";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  acknowledgeTransferJob: vi.fn(),
  attachTransferJob: vi.fn(),
  cancelTransfer: vi.fn(),
  disconnectSession: vi.fn(),
  getDeviceStatus: vi.fn(),
  getDeviceMetricsSnapshot: vi.fn(),
  listRemoteFiles: vi.fn(),
  open: vi.fn(),
  resolveTransferJobConflict: vi.fn(),
  save: vi.fn(),
  startTransferJob: vi.fn<(request: StartTransferJobRequest) => Promise<TransferJobSummary>>(),
  transferJobs: new Map<string, TransferJobSummary>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = vi.fn();
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.confirm,
  open: mocks.open,
  save: mocks.save,
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    acknowledgeTransferJob: mocks.acknowledgeTransferJob,
    attachTransferJob: mocks.attachTransferJob,
    cancelTransfer: mocks.cancelTransfer,
    disconnectSession: mocks.disconnectSession,
    getDeviceStatus: mocks.getDeviceStatus,
    getDeviceMetricsSnapshot: mocks.getDeviceMetricsSnapshot,
    listRemoteFiles: mocks.listRemoteFiles,
    resolveTransferJobConflict: mocks.resolveTransferJobConflict,
    startTransferJob: mocks.startTransferJob,
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface TestChannel<T> {
  onmessage: (event: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const connection: SshConnection = {
  connectionId: "connection-1",
  sessionId: "session-1",
  homePath: "/home",
  sftpAvailable: true,
};

const deviceStatus: DeviceStatus = {
  sessionId: "session-1",
  available: true,
};

function deviceSnapshot(windowEndMs = 10_000, connectionId = connection.connectionId): DeviceMetricsSnapshot {
  return {
    connectionId,
    windowEndMs,
    status: deviceStatus,
    history: [{
      sampledAtMs: windowEndMs,
      cpuPercent: 25,
      memoryPercent: 50,
      networkDownloadBytesPerSecond: 100,
      networkUploadBytesPerSecond: 200,
    }],
  };
}

let transferJobSequence = 0;

function transferJob(
  request: StartTransferJobRequest,
  state: TransferJobState = "running",
): TransferJobSummary {
  const job: TransferJobSummary = {
    jobId: `job-${++transferJobSequence}`,
    runtimeId: request.runtimeId,
    connectionId: request.connectionId,
    direction: request.kind === "uploadBatch" ? "upload" : "download",
    fileName:
      request.kind === "uploadBatch"
        ? request.localPaths[0]?.split(/[\\/]/).pop() ?? "文件"
        : request.remotePath.split("/").pop() ?? "文件",
    batchIndex: 1,
    batchTotal: request.kind === "uploadBatch" ? request.localPaths.length : 1,
    transferredBytes: 0,
    totalBytes: 100,
    state,
    message: null,
    uploaded: 0,
    skipped: 0,
    failed: 0,
  };
  mocks.transferJobs.set(job.jobId, job);
  return job;
}

function file(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind: "file",
    owner: "root",
    group: "root",
    permissions: "rw-r--r--",
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  transferJobSequence = 0;
  mocks.transferJobs.clear();
  initializeLightweightMode({
    active: false,
    suppressConfirmation: false,
    phase: "normal",
    terminals: [],
    transferJobs: [],
  });
  mocks.confirm.mockResolvedValue(false);
  mocks.acknowledgeTransferJob.mockResolvedValue(undefined);
  mocks.cancelTransfer.mockResolvedValue(true);
  mocks.disconnectSession.mockResolvedValue(undefined);
  mocks.getDeviceStatus.mockResolvedValue(deviceStatus);
  mocks.getDeviceMetricsSnapshot.mockReset().mockImplementation(async (connectionId: string) =>
    deviceSnapshot(10_000, connectionId),
  );
  mocks.listRemoteFiles.mockResolvedValue([]);
  mocks.open.mockResolvedValue(null);
  mocks.resolveTransferJobConflict.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(null);
  mocks.startTransferJob.mockImplementation(async (request: StartTransferJobRequest) =>
    transferJob(request),
  );
  mocks.attachTransferJob.mockImplementation(
    async (jobId: string, channel: TestChannel<TransferJobEvent>) => {
      const job = mocks.transferJobs.get(jobId);
      if (!job) throw new Error("后台传输任务不存在");
      channel.onmessage({ kind: "updated", job });
      return job;
    },
  );
});

describe("设备状态首屏加载", () => {
  it("连接已完成但缓存为空时保持加载态，250 毫秒后立即展示首轮结果", async () => {
    vi.useFakeTimers();
    const ready = deviceSnapshot(250);
    mocks.getDeviceMetricsSnapshot
      .mockResolvedValueOnce({ ...ready, status: null, history: [], windowEndMs: 0 })
      .mockResolvedValue(ready);
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => result.current.handleConnected("tab-1", connection));
    expect(result.current.runtimes["tab-1"].connectionState).toBe("connected");
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(true);
    expect(result.current.runtimes["tab-1"].deviceStatus).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(mocks.getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual(ready.history);
    expect(result.current.runtimes["tab-1"].deviceWindowEndMs).toBe(250);
    expect(mocks.getDeviceMetricsSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.getDeviceStatus).not.toHaveBeenCalled();
  });

  it("首屏读取失败超过期限退出加载态，不覆盖 SSH 状态，后续仍可恢复", async () => {
    vi.useFakeTimers();
    mocks.getDeviceMetricsSnapshot.mockRejectedValue(new Error("缓存暂不可读"));
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => result.current.handleConnected("tab-1", connection));
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    expect(result.current.runtimes["tab-1"].deviceStatus).toBeNull();
    expect(result.current.runtimes["tab-1"].connectionState).toBe("connected");
    expect(result.current.runtimes["tab-1"].error).toBeNull();
    const ready = deviceSnapshot(15_000);
    mocks.getDeviceMetricsSnapshot.mockResolvedValue(ready);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual(ready.history);
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    expect(mocks.getDeviceStatus).not.toHaveBeenCalled();
  });

  it("开始断开即退出加载态，断开期间迟到的缓存不能写回", async () => {
    vi.useFakeTimers();
    const pending = deferred<DeviceMetricsSnapshot>();
    const disconnect = deferred<void>();
    mocks.getDeviceMetricsSnapshot.mockReturnValueOnce(pending.promise);
    mocks.disconnectSession.mockReturnValueOnce(disconnect.promise);
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => result.current.handleConnected("tab-1", connection));
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(true);
    let disconnecting!: Promise<void>;
    act(() => { disconnecting = result.current.disconnect("tab-1"); });
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    expect(result.current.runtimes["tab-1"].connectionState).toBe("disconnecting");
    await act(async () => pending.resolve(deviceSnapshot()));
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      disconnect.resolve(undefined);
      await disconnecting;
    });
    expect(result.current.runtimes["tab-1"].connectionState).toBe("disconnected");
  });
});

describe("轻量模式设备曲线", () => {
  it("窗口重建后立即恢复轻量期间新增的完整历史", async () => {
    const firstSnapshot = deviceSnapshot(30_000);
    mocks.getDeviceMetricsSnapshot.mockResolvedValue(firstSnapshot);
    const first = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => first.result.current.handleConnected("tab-1", connection));
    expect(first.result.current.runtimes["tab-1"].deviceHistory).toEqual(firstSnapshot.history);
    first.unmount();
    expect(mocks.disconnectSession).not.toHaveBeenCalled();

    const restoredSnapshot = deviceSnapshot(300_000);
    restoredSnapshot.history.unshift(...firstSnapshot.history);
    mocks.getDeviceMetricsSnapshot.mockResolvedValue(restoredSnapshot);
    initializeLightweightMode({
      active: true,
      suppressConfirmation: false,
      phase: "detached",
      terminals: [{
        runtimeId: "tab-1",
        connectionId: connection.connectionId,
        sessionId: connection.sessionId,
        currentPath: "/home",
      }],
      transferJobs: [],
    });
    const restored = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => {
      restored.result.current.handleTerminalState("tab-1", "connecting");
      restored.result.current.handleConnected("tab-1", connection);
    });
    expect(restored.result.current.runtimes["tab-1"].deviceHistory).toEqual(restoredSnapshot.history);
    expect(restored.result.current.runtimes["tab-1"].deviceWindowEndMs).toBe(300_000);
    expect(restored.result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    expect(mocks.getDeviceStatus).not.toHaveBeenCalled();
  });

  it("同一连接重复恢复不清空现有曲线，也不重复累计", async () => {
    const snapshot = deviceSnapshot();
    mocks.getDeviceMetricsSnapshot.mockResolvedValueOnce(snapshot);
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => result.current.handleConnected("tab-1", connection));
    const pending = deferred<DeviceMetricsSnapshot>();
    mocks.getDeviceMetricsSnapshot.mockReturnValueOnce(pending.promise);
    act(() => result.current.handleConnected("tab-1", connection));
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual(snapshot.history);
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    await act(async () => pending.resolve(snapshot));
    expect(result.current.runtimes["tab-1"].deviceHistory).toHaveLength(1);
  });

  it("重连时旧统计请求失效，新连接可以从较小时间起点开始", async () => {
    const pending = deferred<DeviceMetricsSnapshot>();
    mocks.getDeviceMetricsSnapshot.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => result.current.handleConnected("tab-1", connection));
    act(() => result.current.handleTerminalState("tab-1", "connecting"));
    expect(result.current.runtimes["tab-1"].deviceLoading).toBe(false);
    await act(async () => pending.resolve(deviceSnapshot(900_000)));
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual([]);

    const newConnection = { ...connection, connectionId: "connection-2" };
    const snapshot = deviceSnapshot(500, newConnection.connectionId);
    mocks.getDeviceMetricsSnapshot.mockResolvedValue(snapshot);
    await act(async () => result.current.handleConnected("tab-1", newConnection));
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual(snapshot.history);
    expect(result.current.runtimes["tab-1"].deviceWindowEndMs).toBe(500);
  });

  it("同一服务器的多个标签按连接编号隔离历史", async () => {
    const first = deviceSnapshot(30_000);
    const second = deviceSnapshot(5_000, "connection-2");
    second.history[0].cpuPercent = 80;
    mocks.getDeviceMetricsSnapshot.mockImplementation(async (connectionId: string) =>
      connectionId === first.connectionId ? first : second,
    );
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await act(async () => {
      result.current.handleConnected("tab-1", connection);
      result.current.handleConnected("tab-2", { ...connection, connectionId: second.connectionId });
    });
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual(first.history);
    expect(result.current.runtimes["tab-2"].deviceHistory).toEqual(second.history);
    act(() => result.current.handleTerminalState("tab-1", "disconnected"));
    expect(result.current.runtimes["tab-1"].deviceHistory).toEqual([]);
    expect(result.current.runtimes["tab-2"].deviceHistory).toEqual(second.history);
  });
});

describe("会话运行时异步生命周期", () => {
  it("连接完成前收到的首个终端目录会覆盖初始目录", async () => {
    mocks.listRemoteFiles.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );

    act(() => result.current.handleTerminalState("session-1", "connecting"));
    act(() => result.current.handleTerminalDirectory("session-1", "/srv/first"));
    act(() => result.current.handleConnected("session-1", connection));

    expect(result.current.runtimes["session-1"]?.currentPath).toBe("/srv/first");
    expect(mocks.listRemoteFiles).toHaveBeenCalledWith("connection-1", "/srv/first");
  });

  it("丢弃晚到的旧目录响应", async () => {
    const homeRequest = deferred<FileEntry[]>();
    const nextRequest = deferred<FileEntry[]>();
    mocks.listRemoteFiles
      .mockReturnValueOnce(homeRequest.promise)
      .mockReturnValueOnce(nextRequest.promise);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );

    act(() => result.current.handleConnected("session-1", connection));
    act(() => result.current.openPath("session-1", "/next"));
    nextRequest.resolve([file("/next/new.txt")]);

    await waitFor(() => {
      expect(result.current.runtimes["session-1"]?.files[0]?.path).toBe(
        "/next/new.txt",
      );
    });

    homeRequest.resolve([file("/home/old.txt")]);
    await act(async () => Promise.resolve());

    expect(result.current.runtimes["session-1"]?.currentPath).toBe("/next");
    expect(result.current.runtimes["session-1"]?.files[0]?.path).toBe(
      "/next/new.txt",
    );
  });

  it("StrictMode 卸载后停止设备轮询", async () => {
    vi.useFakeTimers();
    mocks.listRemoteFiles.mockResolvedValue([]);
    mocks.getDeviceMetricsSnapshot.mockResolvedValue({
      ...deviceSnapshot(), status: null, history: [], windowEndMs: 0,
    });
    const { result, unmount } = renderHook(
      () => useSessionConnections({ errorFallback: "未知错误" }),
      { wrapper: StrictMode },
    );

    act(() => result.current.handleConnected("session-1", connection));
    await act(async () => Promise.resolve());
    expect(mocks.getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.runtimes["session-1"].deviceLoading).toBe(true);

    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mocks.getDeviceMetricsSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getDeviceStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("裁剪失效会话只断开现有连接一次", async () => {
    mocks.listRemoteFiles.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    act(() => result.current.pruneRuntimes(new Set()));
    act(() => result.current.pruneRuntimes(new Set()));
    await waitFor(() => expect(mocks.disconnectSession).toHaveBeenCalledTimes(1));
    expect(mocks.disconnectSession).toHaveBeenCalledWith("connection-1");
  });

  it("裁剪会话时吞掉后台断开失败", async () => {
    mocks.listRemoteFiles.mockResolvedValue([]);
    mocks.disconnectSession.mockRejectedValueOnce(new Error("offline"));
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    act(() => result.current.pruneRuntimes(new Set()));
    await act(async () => Promise.resolve());

    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("连接中关闭会话时用会话 ID 取消后端尝试", async () => {
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleTerminalState("session-1", "connecting"));

    await act(async () => {
      await result.current.disconnect("session-1");
    });

    expect(mocks.disconnectSession).toHaveBeenCalledWith("session-1");
    expect(result.current.runtimes["session-1"]?.connectionState).toBe("disconnected");
  });

  it("恢复 WebView 后重新挂接后台传输且卸载不取消", async () => {
    const job = transferJob({
      kind: "uploadBatch",
      runtimeId: "session-1",
      connectionId: "connection-1",
      localPaths: ["C:\\tmp\\report.txt"],
      remoteDirectory: "/home",
    });
    initializeLightweightMode({
      active: true,
      suppressConfirmation: false,
      phase: "detached",
      terminals: [],
      transferJobs: [job],
    });
    const { result, unmount } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );

    await waitFor(() => expect(mocks.attachTransferJob).toHaveBeenCalledWith(
      job.jobId,
      expect.anything(),
    ));
    expect(result.current.runtimes["session-1"]?.transfer?.id).toBe(job.jobId);
    unmount();
    expect(mocks.cancelTransfer).not.toHaveBeenCalled();
  });

  it("终端恢复中的连接通知不丢弃后台任务，断线后仍展示任务结果", async () => {
    const job = transferJob({ kind: "uploadBatch", runtimeId: "session-1", connectionId: connection.connectionId,
      localPaths: ["C:\\uploads\\report.txt"], remoteDirectory: "/home" });
    initializeLightweightMode({ active: true, suppressConfirmation: false, phase: "detached",
      terminals: [{ runtimeId: "session-1", connectionId: connection.connectionId, sessionId: connection.sessionId, currentPath: "/home" }],
      transferJobs: [job] });
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    await waitFor(() => expect(mocks.attachTransferJob).toHaveBeenCalledOnce());
    act(() => result.current.handleTerminalState("session-1", "connecting"));
    act(() => result.current.handleConnected("session-1", connection));
    const channel = mocks.attachTransferJob.mock.calls[0]?.[1] as TestChannel<TransferJobEvent>;
    act(() => channel.onmessage({ kind: "updated", job: { ...job, state: "completed", transferredBytes: 100 } }));
    expect(result.current.runtimes["session-1"]?.transfer?.state).toBe("completed");
    act(() => result.current.handleTerminalState("session-1", "disconnected"));
    expect(result.current.runtimes["session-1"]?.transfer?.state).toBe("completed");
  });

  it("上传重复点击只创建一个后台任务", async () => {
    const request = deferred<TransferJobSummary>();
    mocks.startTransferJob.mockReturnValueOnce(request.promise);
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    act(() => result.current.handleConnected("session-1", connection));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.uploadFiles("session-1", ["C:\\uploads\\first.txt"]);
      second = result.current.uploadFiles("session-1", ["C:\\uploads\\second.txt"]);
    });
    expect(mocks.startTransferJob).toHaveBeenCalledOnce();
    request.resolve(transferJob(mocks.startTransferJob.mock.calls[0]![0]));
    await act(async () => { await Promise.all([first, second]); });
    expect(result.current.runtimes["session-1"]?.error).toBeNull();
    expect(result.current.runtimes["session-1"]?.transfer?.fileName).toBe("first.txt");
  });

  it("上传文件选择结束前重连时不把文件发到新连接", async () => {
    const selection = deferred<string>();
    mocks.open.mockReturnValueOnce(selection.promise);
    const { result } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    act(() => result.current.handleConnected("session-1", connection));
    let pending!: Promise<void>;
    act(() => { pending = result.current.uploadFile("session-1"); });
    act(() => result.current.handleConnected("session-1", { ...connection, connectionId: "new" }));
    selection.resolve("C:\\uploads\\report.txt");
    await act(async () => pending);
    expect(mocks.startTransferJob).not.toHaveBeenCalled();
  });

  it("上传冲突确认后向后台任务提交覆盖决定", async () => {
    mocks.startTransferJob.mockImplementationOnce(
      async (request: StartTransferJobRequest) =>
        transferJob(request, "waitingForConflict"),
    );
    mocks.confirm.mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    await act(async () => {
      await result.current.uploadFiles("session-1", ["C:\\tmp\\report.txt"]);
    });

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.startTransferJob).toHaveBeenCalledWith({
      kind: "uploadBatch",
      runtimeId: "session-1",
      connectionId: "connection-1",
      localPaths: ["C:\\tmp\\report.txt"],
      remoteDirectory: "/home",
    });
    expect(mocks.resolveTransferJobConflict).toHaveBeenCalledWith(
      "job-1",
      "overwrite",
    );
  });

  it("下载冲突确认后向后台任务提交覆盖决定", async () => {
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    mocks.startTransferJob.mockImplementationOnce(
      async (request: StartTransferJobRequest) =>
        transferJob(request, "waitingForConflict"),
    );
    mocks.confirm.mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    await act(async () => {
      await result.current.downloadFile("session-1", file("/home/report.txt"));
    });

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.startTransferJob).toHaveBeenCalledWith({
      kind: "download",
      runtimeId: "session-1",
      connectionId: "connection-1",
      remotePath: "/home/report.txt",
      localPath: "C:\\downloads\\report.txt",
    });
    expect(mocks.resolveTransferJobConflict).toHaveBeenCalledWith(
      "job-1",
      "overwrite",
    );
  });

  it("上传冲突被用户拒绝时提交跳过决定", async () => {
    mocks.startTransferJob.mockImplementationOnce(
      async (request: StartTransferJobRequest) =>
        transferJob(request, "waitingForConflict"),
    );
    mocks.confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    await act(async () => {
      await result.current.uploadFiles("session-1", ["C:\\tmp\\skip.txt"]);
    });

    expect(mocks.resolveTransferJobConflict).toHaveBeenCalledWith("job-1", "skip");
  });

  it("下载冲突被用户拒绝时提交取消决定", async () => {
    mocks.save.mockResolvedValueOnce("C:\\downloads\\cancel.txt");
    mocks.startTransferJob.mockImplementationOnce(
      async (request: StartTransferJobRequest) =>
        transferJob(request, "waitingForConflict"),
    );
    mocks.confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    await act(async () => {
      await result.current.downloadFile("session-1", file("/home/cancel.txt"));
    });

    expect(mocks.resolveTransferJobConflict).toHaveBeenCalledWith("job-1", "cancel");
  });

  it("重连后丢弃旧下载失败，不污染新连接状态", async () => {
    const request = deferred<TransferJobSummary>();
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    mocks.startTransferJob.mockReturnValueOnce(request.promise);
    const nextConnection = { ...connection, connectionId: "connection-2" };
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    let oldDownload!: Promise<void>;
    act(() => {
      oldDownload = result.current.downloadFile(
        "session-1",
        file("/home/report.txt"),
      );
    });
    await act(async () => Promise.resolve());
    act(() => result.current.handleConnected("session-1", nextConnection));
    request.reject(new Error("旧连接失败"));
    await act(async () => oldDownload);

    expect(result.current.runtimes["session-1"]?.connection?.connectionId).toBe(
      "connection-2",
    );
    expect(result.current.runtimes["session-1"]?.error).toBeNull();
  });

  it("卸载后传输失败不再更新状态或产生未处理拒绝", async () => {
    const request = deferred<TransferJobSummary>();
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    mocks.startTransferJob.mockReturnValueOnce(request.promise);
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const { result, unmount } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));
    let download!: Promise<void>;
    act(() => {
      download = result.current.downloadFile(
        "session-1",
        file("/home/report.txt"),
      );
    });
    await act(async () => Promise.resolve());
    unmount();
    request.reject(new Error("卸载时失败"));
    await download;

    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it.each(["upload", "download"] as const)("%s 启动响应晚于卸载也不取消后台任务", async (direction) => {
    const request = deferred<TransferJobSummary>();
    mocks.startTransferJob.mockReturnValueOnce(request.promise);
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    const { result, unmount } = renderHook(() => useSessionConnections({ errorFallback: "未知错误" }));
    act(() => result.current.handleConnected("session-1", connection));
    let pending!: Promise<void>;
    act(() => {
      pending = direction === "upload"
        ? result.current.uploadFiles("session-1", ["C:\\uploads\\report.txt"])
        : result.current.downloadFile("session-1", file("/home/report.txt"));
    });
    await act(async () => Promise.resolve());
    expect(mocks.startTransferJob).toHaveBeenCalledOnce();
    const job = transferJob(mocks.startTransferJob.mock.calls[0]![0]);
    unmount();
    request.resolve(job);
    await pending;
    expect(mocks.cancelTransfer).not.toHaveBeenCalled();
    expect(mocks.attachTransferJob).not.toHaveBeenCalled();
  });
});
