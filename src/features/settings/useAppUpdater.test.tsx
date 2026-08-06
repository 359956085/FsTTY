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
  setIgnoredUpdateVersion: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = vi.fn();
  },
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    checkAppUpdate: mocks.checkAppUpdate,
    closeAppUpdate: mocks.closeAppUpdate,
    setIgnoredUpdateVersion: mocks.setIgnoredUpdateVersion,
  },
}));

const settings = {
  updateProxy: "",
} as AppSettings;

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
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
          proxy: "",
          startupReady: true,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());

    expect(result.current.phase).toBe("idle");
    expect(result.current.dialogOpen).toBe(false);
  });

  it("启动检查发现新版本时打开更新弹窗", async () => {
    mocks.checkAppUpdate.mockResolvedValue({ version: "v1.3.0" });
    const { result } = renderHook(
      () =>
        useAppUpdater({
          autoUpdate: true,
          ignoredUpdateVersion: null,
          onSettingsChange: vi.fn(),
          proxy: "",
          startupReady: true,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(result.current.dialogOpen).toBe(true));

    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("available");
    expect(result.current.availableUpdate?.version).toBe("1.3.0");
  });

  it("启动检查忽略已忽略版本且关闭更新句柄", async () => {
    mocks.checkAppUpdate.mockResolvedValue({ version: "1.3.0" });
    const { result } = renderHook(
      () =>
        useAppUpdater({
          autoUpdate: true,
          ignoredUpdateVersion: "1.3.0",
          onSettingsChange: vi.fn(),
          proxy: "",
          startupReady: true,
        }),
      { wrapper: StrictMode },
    );

    await waitFor(() => expect(mocks.closeAppUpdate).toHaveBeenCalledTimes(1));

    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    expect(result.current.dialogOpen).toBe(false);
  });
});
