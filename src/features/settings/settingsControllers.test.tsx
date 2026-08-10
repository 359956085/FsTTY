// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import type { AppUpdaterController } from "./useAppUpdater";
import { useGeneralSettings } from "./useGeneralSettings";
import { useMcpSettings } from "./useMcpSettings";

const apiMocks = vi.hoisted(() => ({
  getMcpHttpClientConfig: vi.fn(),
  getMcpPermissionCatalog: vi.fn(),
  getMcpStdioClientConfig: vi.fn(),
  listSessions: vi.fn(),
  rotateMcpHttpToken: vi.fn(),
  setTheme: vi.fn(),
  updateAppSettings: vi.fn(),
  updateMcpSettings: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: apiMocks,
}));

vi.mock("./useMcpPromptCopy", () => ({
  useMcpPromptCopy: () => ({
    copied: false,
    copying: false,
    copy: vi.fn(),
    error: null,
  }),
}));

const shortcuts = {
  terminalCopy: { alt: false, code: "KeyC", ctrl: true, shift: true },
  terminalPaste: { alt: false, code: "KeyV", ctrl: true, shift: true },
  commandHistory: { alt: false, code: "KeyR", ctrl: true, shift: false },
  commandHistorySearch: { alt: false, code: "KeyR", ctrl: true, shift: true },
};

const settings: AppSettings = {
  allowRemoteClipboardWrite: false,
  autoUpdate: true,
  ignoredUpdateVersion: null,
  language: "zh-CN",
  theme: "system",
  mcpEnabled: true,
  mcpGroupPermissions: [],
  mcpHttpEnabled: false,
  mcpHttpPort: 37653,
  recordMcpToolInputs: false,
  shortcuts,
  updateProxy: "",
  updateSource: "auto",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("设置状态控制器", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listSessions.mockResolvedValue([]);
    apiMocks.getMcpPermissionCatalog.mockResolvedValue([]);
  });

  it("串行保存更新设置，并按提交顺序应用结果", async () => {
    const first = deferred<AppSettings>();
    const second = deferred<AppSettings>();
    apiMocks.updateAppSettings
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useGeneralSettings({
        onChange,
        settings,
        translate: (key) => key,
        updater: {} as AppUpdaterController,
      }),
    );

    let firstSave!: Promise<AppSettings | null>;
    let secondSave!: Promise<AppSettings | null>;
    act(() => {
      firstSave = result.current.saveUpdateSettings(true, "http://first");
      secondSave = result.current.saveUpdateSettings(true, "http://second");
    });
    await act(async () => Promise.resolve());
    expect(apiMocks.updateAppSettings).toHaveBeenCalledTimes(1);

    const firstResult = { ...settings, updateProxy: "http://first" };
    await act(async () => {
      first.resolve(firstResult);
      await firstSave;
    });
    expect(apiMocks.updateAppSettings).toHaveBeenCalledTimes(2);

    const secondResult = { ...settings, updateProxy: "http://second" };
    await act(async () => {
      second.resolve(secondResult);
      await secondSave;
    });
    expect(onChange).toHaveBeenNthCalledWith(1, firstResult);
    expect(onChange).toHaveBeenNthCalledWith(2, secondResult);
  });

  it("卸载后不应用保存结果", async () => {
    const request = deferred<AppSettings>();
    apiMocks.updateAppSettings.mockReturnValue(request.promise);
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useGeneralSettings({
        onChange,
        settings,
        translate: (key) => key,
        updater: {} as AppUpdaterController,
      }),
    );
    let save!: Promise<AppSettings | null>;
    act(() => {
      save = result.current.saveUpdateSettings(true);
    });
    await act(async () => Promise.resolve());
    expect(apiMocks.updateAppSettings).toHaveBeenCalledTimes(1);
    unmount();
    request.resolve(settings);
    await save;
    expect(onChange).not.toHaveBeenCalled();
  });

  it("保存自动、GitHub 和 CNB 下载源", async () => {
    apiMocks.updateAppSettings.mockImplementation(
      async (
        autoUpdate: boolean,
        updateProxy: string,
        allowRemoteClipboardWrite: boolean,
        updateSource: AppSettings["updateSource"],
      ) => ({
        ...settings,
        allowRemoteClipboardWrite,
        autoUpdate,
        updateProxy,
        updateSource,
      }),
    );
    const { result } = renderHook(() =>
      useGeneralSettings({
        onChange: vi.fn(),
        settings,
        translate: (key) => key,
        updater: {} as AppUpdaterController,
      }),
    );

    for (const source of ["auto", "github", "cnb"] as const) {
      await act(async () => {
        await result.current.saveUpdateSettings(true, "", false, source);
      });
    }

    expect(apiMocks.updateAppSettings.mock.calls[0]?.[3]).toBe("auto");
    expect(apiMocks.updateAppSettings.mock.calls[1]?.[3]).toBe("github");
    expect(apiMocks.updateAppSettings.mock.calls[2]?.[3]).toBe("cnb");
  });

  it("主题保存成功、失败和重复点击均保持一致状态", async () => {
    const request = deferred<AppSettings>();
    apiMocks.setTheme.mockReturnValueOnce(request.promise);
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useGeneralSettings({
        onChange,
        settings,
        translate: (key) => key,
        updater: {} as AppUpdaterController,
      }),
    );

    let first!: Promise<void>;
    act(() => {
      first = result.current.changeTheme("light");
      void result.current.changeTheme("dark");
    });
    expect(apiMocks.setTheme).toHaveBeenCalledTimes(1);
    expect(result.current.savingTheme).toBe(true);

    const lightSettings = { ...settings, theme: "light" as const };
    await act(async () => {
      request.resolve(lightSettings);
      await first;
    });
    expect(onChange).toHaveBeenCalledWith(lightSettings);
    expect(result.current.savingTheme).toBe(false);

    apiMocks.setTheme.mockRejectedValueOnce(new Error("theme failed"));
    await act(async () => result.current.changeTheme("dark"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("theme failed");
  });

  it("StrictMode 重放后仍能手工检查更新", async () => {
    apiMocks.updateAppSettings.mockResolvedValue(settings);
    const checkForUpdates = vi.fn().mockResolvedValue(undefined);
    const updater = { checkForUpdates } as unknown as AppUpdaterController;
    const { result } = renderHook(
      () =>
        useGeneralSettings({
          onChange: vi.fn(),
          settings,
          translate: (key) => key,
          updater,
        }),
      { wrapper: StrictMode },
    );

    await act(async () => result.current.checkForUpdates());

    expect(apiMocks.updateAppSettings).toHaveBeenCalledTimes(1);
    expect(checkForUpdates).toHaveBeenCalledWith(
      "manual",
      settings.updateProxy,
      settings.updateSource,
    );
  });

  it("StrictMode 重放后仍能保存 MCP 设置", async () => {
    const nextSettings = { ...settings, mcpEnabled: false };
    apiMocks.updateMcpSettings.mockResolvedValue(nextSettings);
    const onChange = vi.fn();
    const { result } = renderHook(
      () => useMcpSettings({ onChange, settings, translate: (key) => key }),
      { wrapper: StrictMode },
    );

    await act(async () => result.current.save("stdio", false));

    expect(apiMocks.updateMcpSettings).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(nextSettings);
    expect(result.current.saving).toBe(false);
  });

  it("StrictMode 重放后轮换 Token 能结束处理中状态并显示错误", async () => {
    apiMocks.rotateMcpHttpToken.mockResolvedValueOnce(undefined);
    const { result } = renderHook(
      () => useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
      { wrapper: StrictMode },
    );

    await act(async () => result.current.rotateToken());
    expect(result.current.saving).toBe(false);

    apiMocks.rotateMcpHttpToken.mockRejectedValueOnce(new Error("token failed"));
    await act(async () => result.current.rotateToken());

    expect(result.current.saving).toBe(false);
    expect(result.current.httpError).toBe("token failed");
  });

  it("MCP 配置只接受最新请求，关闭后丢弃响应", async () => {
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();
    apiMocks.getMcpHttpClientConfig
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);
    const { result } = renderHook(() =>
      useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
    );

    act(() => result.current.openConfigDialog("http"));
    let latest!: Promise<void>;
    act(() => {
      latest = result.current.loadConfig("http", "claude");
    });
    await act(async () => {
      newRequest.resolve("new-config");
      await latest;
    });
    expect(result.current.configDialog?.config).toBe("new-config");

    oldRequest.resolve("old-config");
    await act(async () => Promise.resolve());
    expect(result.current.configDialog?.config).toBe("new-config");

    const closedRequest = deferred<string>();
    apiMocks.getMcpHttpClientConfig.mockReturnValueOnce(closedRequest.promise);
    act(() => result.current.openConfigDialog("http"));
    act(() => result.current.closeConfigDialog());
    closedRequest.resolve("closed-config");
    await act(async () => Promise.resolve());
    expect(result.current.configDialog).toBeNull();
  });
});
