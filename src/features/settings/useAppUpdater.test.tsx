// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import { useAppUpdater } from "./useAppUpdater";

const mocks = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  closeAppUpdate: vi.fn(),
  getVersion: vi.fn(),
  installAppUpdate: vi.fn(),
  channels: [] as Array<{ onmessage?: (event: { kind: string }) => void }>,
  setIgnoredUpdateVersion: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (event: { kind: string }) => void;
    constructor() {
      mocks.channels.push(this);
    }
  },
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    checkAppUpdate: mocks.checkAppUpdate,
    closeAppUpdate: mocks.closeAppUpdate,
    installAppUpdate: mocks.installAppUpdate,
    setIgnoredUpdateVersion: mocks.setIgnoredUpdateVersion,
  },
}));

const settings = {
  proxyAddress: "",
  proxyEnabled: false,
} as AppSettings;

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channels.length = 0;
  mocks.getVersion.mockResolvedValue("1.2.1");
  mocks.closeAppUpdate.mockResolvedValue(undefined);
  mocks.setIgnoredUpdateVersion.mockResolvedValue(settings);
});

describe("应用启动自动更新", () => {
  it("StrictMode 重放时只检查一次，最新版保持静默", async () => {
    mocks.checkAppUpdate.mockResolvedValue(null);
    const { result } = renderHook(
      () =>
        useAppUpdater({
          autoUpdate: true,
          ignoredUpdateVersion: null,
          onSettingsChange: vi.fn(),
          updateSource: "auto",
          startupReady: true,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());

    expect(result.current.phase).toBe("idle");
    expect(result.current.dialogOpen).toBe(false);
    expect(mocks.checkAppUpdate).toHaveBeenCalledWith("auto");
  });

  it("启动检查发现新版本时打开更新弹窗", async () => {
    mocks.checkAppUpdate.mockResolvedValue({ version: "v1.3.0" });
    const { result } = renderHook(
      () =>
        useAppUpdater({
          autoUpdate: true,
          ignoredUpdateVersion: null,
          onSettingsChange: vi.fn(),
          updateSource: "github",
          startupReady: true,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(result.current.dialogOpen).toBe(true));

    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("available");
    expect(result.current.availableUpdate?.version).toBe("1.3.0");
    expect(mocks.checkAppUpdate).toHaveBeenCalledWith("github");
  });

  it("启动检查忽略已忽略版本且关闭更新句柄", async () => {
    mocks.checkAppUpdate.mockResolvedValue({ version: "1.3.0" });
    const { result } = renderHook(
      () =>
        useAppUpdater({
          autoUpdate: true,
          ignoredUpdateVersion: "1.3.0",
          onSettingsChange: vi.fn(),
          updateSource: "mirror",
          startupReady: true,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(mocks.closeAppUpdate).toHaveBeenCalledTimes(1));

    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    expect(result.current.dialogOpen).toBe(false);
    expect(mocks.checkAppUpdate).toHaveBeenCalledWith("mirror");
  });
});

describe("应用更新安装状态", () => {
  it("安装开始后保持安装中，等待安装调用结束再报告完成", async () => {
    mocks.checkAppUpdate.mockResolvedValue({ version: "1.7.1" });
    let finishInstall: (() => void) | undefined;
    mocks.installAppUpdate.mockImplementation(
      () => new Promise<void>((resolve) => { finishInstall = resolve; }),
    );
    const { result } = renderHook(() => useAppUpdater({
      autoUpdate: false,
      ignoredUpdateVersion: null,
      onSettingsChange: vi.fn(),
      updateSource: "auto",
      startupReady: true,
    }));
    await act(async () => { await result.current.checkForUpdates(); });
    expect(result.current.phase).toBe("available");
    act(() => { void result.current.installUpdate(); });
    await waitFor(() => expect(mocks.channels).toHaveLength(1));
    act(() => { mocks.channels[0].onmessage?.({ kind: "installing" }); });
    expect(result.current.phase).toBe("installing");
    await act(async () => { finishInstall?.(); });
    expect(result.current.phase).toBe("completed");
  });
});
