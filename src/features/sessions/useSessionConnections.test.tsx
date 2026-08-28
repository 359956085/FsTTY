// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceStatus, FileEntry, SshConnection } from "../../shared/api/types";
import { useSessionConnections } from "./useSessionConnections";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  disconnectSession: vi.fn(),
  downloadFile: vi.fn(),
  getDeviceStatus: vi.fn(),
  listRemoteFiles: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  uploadFile: vi.fn(),
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
    disconnectSession: mocks.disconnectSession,
    downloadFile: mocks.downloadFile,
    getDeviceStatus: mocks.getDeviceStatus,
    listRemoteFiles: mocks.listRemoteFiles,
    uploadFile: mocks.uploadFile,
    cancelTransfer: vi.fn(),
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
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
  mocks.confirm.mockResolvedValue(false);
  mocks.disconnectSession.mockResolvedValue(undefined);
  mocks.downloadFile.mockResolvedValue(undefined);
  mocks.getDeviceStatus.mockResolvedValue(deviceStatus);
  mocks.listRemoteFiles.mockResolvedValue([]);
  mocks.open.mockResolvedValue(null);
  mocks.save.mockResolvedValue(null);
  mocks.uploadFile.mockResolvedValue(undefined);
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
    const { result, unmount } = renderHook(
      () => useSessionConnections({ errorFallback: "未知错误" }),
      { wrapper: StrictMode },
    );

    act(() => result.current.handleConnected("session-1", connection));
    await act(async () => Promise.resolve());
    expect(mocks.getDeviceStatus).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mocks.getDeviceStatus).toHaveBeenCalledTimes(1);
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

  it("上传冲突确认后只使用覆盖参数重试一次", async () => {
    mocks.uploadFile
      .mockRejectedValueOnce({ kind: "conflict", message: "目标已存在" })
      .mockResolvedValueOnce(undefined);
    mocks.confirm.mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    await act(async () => {
      await result.current.uploadFiles("session-1", ["C:\\tmp\\report.txt"]);
    });

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile).toHaveBeenNthCalledWith(
      1,
      "connection-1",
      expect.any(String),
      "C:\\tmp\\report.txt",
      "/home",
      false,
      expect.anything(),
    );
    expect(mocks.uploadFile).toHaveBeenNthCalledWith(
      2,
      "connection-1",
      expect.any(String),
      "C:\\tmp\\report.txt",
      "/home",
      true,
      expect.anything(),
    );
  });

  it("下载冲突确认后只使用覆盖参数重试一次", async () => {
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    mocks.downloadFile
      .mockRejectedValueOnce({ kind: "conflict", message: "目标已存在" })
      .mockResolvedValueOnce(undefined);
    mocks.confirm.mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useSessionConnections({ errorFallback: "未知错误" }),
    );
    act(() => result.current.handleConnected("session-1", connection));

    await act(async () => {
      await result.current.downloadFile("session-1", file("/home/report.txt"));
    });

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.downloadFile).toHaveBeenNthCalledWith(
      1,
      "connection-1",
      expect.any(String),
      "/home/report.txt",
      "C:\\downloads\\report.txt",
      false,
      expect.anything(),
    );
    expect(mocks.downloadFile).toHaveBeenNthCalledWith(
      2,
      "connection-1",
      expect.any(String),
      "/home/report.txt",
      "C:\\downloads\\report.txt",
      true,
      expect.anything(),
    );
  });

  it("重连后丢弃旧下载失败，不污染新连接状态", async () => {
    const request = deferred<void>();
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    mocks.downloadFile.mockReturnValueOnce(request.promise);
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
    const request = deferred<void>();
    mocks.save.mockResolvedValueOnce("C:\\downloads\\report.txt");
    mocks.downloadFile.mockReturnValueOnce(request.promise);
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
});
