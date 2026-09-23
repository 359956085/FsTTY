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
  setTerminalColorScheme: vi.fn(),
  setProxySettings: vi.fn(),
  updateAppSettings: vi.fn(),
  updateMcpSettings: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: apiMocks,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: apiMocks.writeText,
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
  terminalColorScheme: "default",
  mcpEnabled: true,
  mcpGroupPermissions: [],
  mcpHttpEnabled: false,
  mcpHttpPort: 37653,
  recordMcpToolInputs: false,
  shortcuts,
  proxyAddress: "",
  proxyEnabled: false,
  updateSource: "auto",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
      firstSave = result.current.saveUpdateSettings(true, false, "github");
      secondSave = result.current.saveUpdateSettings(false, true, "mirror");
    });
    await act(async () => Promise.resolve());
    expect(apiMocks.updateAppSettings).toHaveBeenCalledTimes(1);

    const firstResult = { ...settings, updateSource: "github" as const };
    await act(async () => {
      first.resolve(firstResult);
      await firstSave;
    });
    expect(apiMocks.updateAppSettings).toHaveBeenCalledTimes(2);

    const secondResult = { ...settings, updateSource: "mirror" as const };
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

  it("保存自动、GitHub 和官方镜像下载源", async () => {
    apiMocks.updateAppSettings.mockImplementation(
      async (
        autoUpdate: boolean,
        allowRemoteClipboardWrite: boolean,
        updateSource: AppSettings["updateSource"],
      ) => ({
        ...settings,
        allowRemoteClipboardWrite,
        autoUpdate,
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

    for (const source of ["auto", "github", "mirror"] as const) {
      await act(async () => {
        await result.current.saveUpdateSettings(true, false, source);
      });
    }

    expect(apiMocks.updateAppSettings.mock.calls[0]).toEqual([true, false, "auto"]);
    expect(apiMocks.updateAppSettings.mock.calls[1]).toEqual([true, false, "github"]);
    expect(apiMocks.updateAppSettings.mock.calls[2]).toEqual([true, false, "mirror"]);
    expect(apiMocks.setProxySettings).not.toHaveBeenCalled();
  });


  it("代理独立保存、去除首尾空格、重复提交防护及失败重试", async () => {
    const request = deferred<AppSettings>();
    apiMocks.setProxySettings.mockReturnValueOnce(request.promise);
    const onChange = vi.fn();
    const { result } = renderHook(() => useGeneralSettings({
      onChange, settings, translate: (key) => key, updater: {} as AppUpdaterController,
    }));
    act(() => result.current.setProxy("  http://127.0.0.1:7890  "));
    let save!: Promise<void>;
    act(() => {
      save = result.current.saveProxy();
      void result.current.saveProxy();
    });
    await act(async () => Promise.resolve());
    expect(result.current.savingProxy).toBe(true);
    expect(apiMocks.setProxySettings).toHaveBeenCalledTimes(1);
    expect(apiMocks.setProxySettings).toHaveBeenCalledWith(false, "http://127.0.0.1:7890");
    await act(async () => {
      request.reject(new Error("代理保存失败"));
      await save;
    });
    expect(result.current.proxyError).toBe("代理保存失败");
    expect(result.current.proxy).toBe("  http://127.0.0.1:7890  ");
    expect(result.current.savingProxy).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    const saved = { ...settings, proxyAddress: "http://127.0.0.1:7890" };
    apiMocks.setProxySettings.mockResolvedValueOnce(saved);
    await act(async () => result.current.saveProxy());
    expect(onChange).toHaveBeenCalledWith(saved);
    expect(result.current.proxyError).toBeNull();
    expect(result.current.proxy).toBe(saved.proxyAddress);
    expect(apiMocks.updateAppSettings).not.toHaveBeenCalled();
  });

  it("未修改代理不提交，关闭时清空已保存地址仍保持关闭", async () => {
    const configured = { ...settings, proxyAddress: "socks5://127.0.0.1:1080" };
    const { result } = renderHook(() => useGeneralSettings({
      onChange: vi.fn(), settings: configured, translate: (key) => key, updater: {} as AppUpdaterController,
    }));
    await act(async () => result.current.saveProxy());
    expect(apiMocks.setProxySettings).not.toHaveBeenCalled();
    apiMocks.setProxySettings.mockResolvedValueOnce(settings);
    act(() => result.current.setProxy(""));
    await act(async () => result.current.saveProxy());
    expect(apiMocks.setProxySettings).toHaveBeenCalledWith(false, "");
  });

  it("开关失败保持关闭，成功开启后关闭仍保留地址", async () => {
    const onChange = vi.fn();
    const options = { onChange, settings, translate: (key: string) => key, updater: {} as AppUpdaterController };
    const { result, rerender } = renderHook((props) => useGeneralSettings(props), { initialProps: options });
    apiMocks.setProxySettings.mockRejectedValueOnce(new Error("开启代理前请输入代理地址"));
    await act(async () => result.current.saveProxy(true));
    expect(apiMocks.setProxySettings).toHaveBeenLastCalledWith(true, "");
    expect(result.current.proxyError).toBe("开启代理前请输入代理地址");
    expect(onChange).not.toHaveBeenCalled();
    act(() => result.current.setProxy("socks5://127.0.0.1:1080"));
    const enabled = { ...settings, proxyEnabled: true, proxyAddress: "socks5://127.0.0.1:1080" };
    apiMocks.setProxySettings.mockResolvedValueOnce(enabled);
    await act(async () => result.current.saveProxy(true));
    expect(onChange).toHaveBeenLastCalledWith(enabled);
    rerender({ ...options, settings: enabled });
    const disabled = { ...enabled, proxyEnabled: false };
    apiMocks.setProxySettings.mockResolvedValueOnce(disabled);
    await act(async () => result.current.saveProxy(false));
    expect(apiMocks.setProxySettings).toHaveBeenLastCalledWith(false, enabled.proxyAddress);
    expect(onChange).toHaveBeenLastCalledWith(disabled);
    expect(result.current.proxy).toBe(enabled.proxyAddress);
  });

  it("更新与代理交叉保存保持提交顺序，不遗留忙状态", async () => {
    const flags = deferred<AppSettings>();
    const proxy = deferred<AppSettings>();
    apiMocks.updateAppSettings.mockReturnValueOnce(flags.promise);
    apiMocks.setProxySettings.mockReturnValueOnce(proxy.promise);
    const { result } = renderHook(() => useGeneralSettings({
      onChange: vi.fn(), settings, translate: (key) => key, updater: {} as AppUpdaterController,
    }));
    act(() => result.current.setProxy("http://127.0.0.1:7890"));
    let flagsSave!: Promise<AppSettings | null>;
    let proxySave!: Promise<void>;
    act(() => {
      flagsSave = result.current.saveUpdateSettings(false);
      proxySave = result.current.saveProxy();
    });
    await act(async () => Promise.resolve());
    expect(apiMocks.setProxySettings).not.toHaveBeenCalled();
    await act(async () => { flags.resolve(settings); await flagsSave; });
    expect(result.current.savingUpdateSettings).toBe(false);
    expect(apiMocks.setProxySettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      proxy.resolve({ ...settings, proxyAddress: "http://127.0.0.1:7890" });
      await proxySave;
    });
    expect(result.current.savingProxy).toBe(false);
    expect(apiMocks.updateAppSettings).toHaveBeenCalledWith(false, false, "auto");
  });

  it("其他设置保存不提交代理草稿，代理卸载后不回写状态", async () => {
    apiMocks.updateAppSettings.mockResolvedValue(settings);
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() => useGeneralSettings({
      onChange, settings, translate: (key) => key, updater: {} as AppUpdaterController,
    }));
    act(() => result.current.setProxy("http://draft:7890"));
    await act(async () => result.current.saveUpdateSettings(false, true, "mirror"));
    expect(apiMocks.setProxySettings).not.toHaveBeenCalled();
    expect(result.current.proxy).toBe("http://draft:7890");
    const proxy = deferred<AppSettings>();
    apiMocks.setProxySettings.mockReturnValueOnce(proxy.promise);
    let save!: Promise<void>;
    act(() => { save = result.current.saveProxy(); });
    await act(async () => Promise.resolve());
    unmount();
    proxy.resolve({ ...settings, proxyAddress: "http://draft:7890" });
    await save;
    expect(onChange).toHaveBeenCalledTimes(1);
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

  it("终端配色串行保存，失败保留原设置且不与主题同时提交", async () => {
    const request = deferred<AppSettings>();
    apiMocks.setTerminalColorScheme.mockReturnValueOnce(request.promise);
    const onChange = vi.fn();
    const { result } = renderHook(() => useGeneralSettings({
      onChange, settings, translate: (key) => key, updater: {} as AppUpdaterController,
    }));

    let first!: Promise<void>;
    act(() => {
      first = result.current.changeTerminalColorScheme("nord");
      void result.current.changeTerminalColorScheme("dracula");
      void result.current.changeTheme("light");
    });
    await act(async () => { await Promise.resolve(); });
    expect(apiMocks.setTerminalColorScheme).toHaveBeenCalledExactlyOnceWith("nord");
    expect(apiMocks.setTheme).not.toHaveBeenCalled();
    expect(result.current.savingTerminalColorScheme).toBe(true);

    const selected = { ...settings, terminalColorScheme: "nord" as const };
    await act(async () => { request.resolve(selected); await first; });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(selected);
    expect(result.current.savingTerminalColorScheme).toBe(false);

    apiMocks.setTerminalColorScheme.mockRejectedValueOnce(new Error("palette failed"));
    await act(async () => result.current.changeTerminalColorScheme("solarized"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("palette failed");
    expect(result.current.savingTerminalColorScheme).toBe(false);
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

  it("MCP 保存期间忽略重复请求，不覆盖已提交结果", async () => {
    const request = deferred<AppSettings>();
    apiMocks.updateMcpSettings.mockReturnValue(request.promise);
    const nextSettings = { ...settings, mcpEnabled: false };
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useMcpSettings({ onChange, settings, translate: (key) => key }),
    );

    let firstSave!: Promise<boolean>;
    let duplicateSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.save("stdio", false);
      duplicateSave = result.current.save("stdio", true);
    });
    await act(async () => Promise.resolve());
    expect(apiMocks.updateMcpSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve(nextSettings);
      await firstSave;
      await duplicateSave;
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(nextSettings);
    expect(result.current.saving).toBe(false);
  });

  it("MCP 卸载后不应用保存结果", async () => {
    const request = deferred<AppSettings>();
    apiMocks.updateMcpSettings.mockReturnValue(request.promise);
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMcpSettings({ onChange, settings, translate: (key) => key }),
    );

    let save!: Promise<boolean>;
    act(() => {
      save = result.current.save("stdio", false);
    });
    await act(async () => Promise.resolve());
    unmount();
    request.resolve(settings);
    await save;

    expect(onChange).not.toHaveBeenCalled();
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

  it("权限目录加载失败时显示失败状态并清空旧结果", async () => {
    apiMocks.getMcpPermissionCatalog.mockRejectedValueOnce(new Error("catalog failed"));
    const { result } = renderHook(() =>
      useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
    );

    await act(async () => Promise.resolve());

    expect(result.current.permissionCatalog).toEqual([]);
    expect(result.current.permissionCatalogFailed).toBe(true);
  });

  it("权限保存失败后保留脏状态，并允许再次保存恢复", async () => {
    apiMocks.listSessions.mockResolvedValueOnce([{ name: "生产", sessions: [] }]);
    const nextSettings = {
      ...settings,
      mcpGroupPermissions: [
        {
          groupName: "生产",
          enabled: true,
          sessionRead: true,
          fileRead: true,
          fileTransfer: false,
          commandExecute: false,
          fileWrite: false,
          fileDelete: false,
          commandPolicy: { enabled: false, mode: "allow" as const, allowRules: [], excludeRules: [] },
        },
      ],
    };
    apiMocks.updateMcpSettings
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce(nextSettings);
    const { result } = renderHook(() =>
      useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
    );

    await act(async () => Promise.resolve());
    act(() => result.current.updatePermission("生产", { enabled: true }));
    await act(async () => result.current.save("permissions"));
    expect(result.current.permissionError).toBe("save failed");
    expect(result.current.permissionsDirty).toBe(true);
    expect(result.current.saving).toBe(false);

    await act(async () => result.current.save("permissions"));
    expect(result.current.permissionError).toBeNull();
    expect(result.current.permissionSaveSucceeded).toBe(true);
    expect(result.current.permissionsDirty).toBe(false);
  });

  it("配置加载失败会结束加载状态并保留对话框", async () => {
    apiMocks.getMcpHttpClientConfig.mockRejectedValueOnce(new Error("config failed"));
    const { result } = renderHook(() =>
      useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
    );

    act(() => result.current.openConfigDialog("http"));
    await act(async () => Promise.resolve());

    expect(result.current.configDialog).toMatchObject({
      error: "config failed",
      loading: false,
    });
  });

  it("MCP 配置复制在卸载后丢弃成功和失败结果", async () => {
    const configRequest = deferred<string>();
    const copyRequest = deferred<void>();
    apiMocks.getMcpHttpClientConfig.mockReturnValue(configRequest.promise);
    apiMocks.writeText.mockReturnValue(copyRequest.promise);
    const { result, unmount } = renderHook(() =>
      useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
    );

    act(() => result.current.openConfigDialog("http"));
    await act(async () => {
      configRequest.resolve("mcp-config");
      await Promise.resolve();
    });
    expect(result.current.configDialog?.config).toBe("mcp-config");

    let copy!: Promise<void>;
    act(() => {
      copy = result.current.copyConfig();
    });
    unmount();
    copyRequest.resolve();
    await copy;
    expect(apiMocks.writeText).toHaveBeenCalledWith("mcp-config");

    const failedConfig = deferred<string>();
    const failedCopy = deferred<void>();
    apiMocks.getMcpHttpClientConfig.mockReturnValue(failedConfig.promise);
    apiMocks.writeText.mockReturnValue(failedCopy.promise);
    const second = renderHook(() =>
      useMcpSettings({ onChange: vi.fn(), settings, translate: (key) => key }),
    );
    act(() => second.result.current.openConfigDialog("http"));
    await act(async () => {
      failedConfig.resolve("mcp-config-2");
      await Promise.resolve();
    });
    let failed!: Promise<void>;
    act(() => {
      failed = second.result.current.copyConfig();
    });
    second.unmount();
    failedCopy.reject(new Error("clipboard failed"));
    await failed;
  });
});
