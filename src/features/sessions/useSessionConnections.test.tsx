// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceStatus, FileEntry, SshConnection } from "../../shared/api/types";
import { useSessionConnections } from "./useSessionConnections";

const mocks = vi.hoisted(() => ({
  disconnectSession: vi.fn(),
  getDeviceStatus: vi.fn(),
  listRemoteFiles: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = vi.fn();
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    disconnectSession: mocks.disconnectSession,
    getDeviceStatus: mocks.getDeviceStatus,
    listRemoteFiles: mocks.listRemoteFiles,
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
  mocks.disconnectSession.mockResolvedValue(undefined);
  mocks.getDeviceStatus.mockResolvedValue(deviceStatus);
});

describe("会话运行时异步生命周期", () => {
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
});
