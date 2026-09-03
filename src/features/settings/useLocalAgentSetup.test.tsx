// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, LocalAgentCapability, LocalAgentConfigureResult, McpGroupPermission } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { useLocalAgentSetup } from "./useLocalAgentSetup";
import { useMcpSettings } from "./useMcpSettings";

const apiMocks = vi.hoisted(() => ({
  configureLocalAgents: vi.fn(),
  getAppSettings: vi.fn(),
  getMcpAgentPrompt: vi.fn(),
  getMcpPermissionCatalog: vi.fn(),
  inspectLocalAgentSetup: vi.fn(),
  listSessions: vi.fn(),
  rotateMcpHttpToken: vi.fn(),
  updateMcpSettings: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: apiMocks.writeText }));
vi.mock("./useMcpPromptCopy", () => ({
  useMcpPromptCopy: () => ({ copied: false, copying: false, copy: vi.fn(), error: null }),
}));

const translate = (key: string) => key;
const settings: AppSettings = {
  allowRemoteClipboardWrite: false,
  autoUpdate: false,
  ignoredUpdateVersion: null,
  language: "zh-CN",
  theme: "system",
  mcpEnabled: false,
  mcpGroupPermissions: [],
  mcpHttpEnabled: false,
  mcpHttpPort: 37_653,
  recordMcpToolInputs: false,
  updateProxy: "",
  updateSource: "auto",
  shortcuts: DEFAULT_SHORTCUTS,
};
const capabilities: LocalAgentCapability[] = [
  { target: "codex", installed: true, state: "missing", detail: null },
];
const configured: LocalAgentConfigureResult[] = [
  { target: "codex", mcpStatus: "configured", promptStatus: "configured", message: null },
];
const httpSettings = { ...settings, mcpEnabled: true, mcpHttpEnabled: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderSettings(strict = false) {
  const onChange = vi.fn();
  const hook = renderHook(() => {
    const [currentSettings, setSettings] = useState(settings);
    const configurationBusyRef = useRef(false);
    const mcp = useMcpSettings({
      configurationBusyRef,
      onChange: (next) => { onChange(next); setSettings(next); },
      settings: currentSettings,
      translate,
    });
    const local = useLocalAgentSetup({
      configurationBusyRef,
      getSavedPermissions: mcp.getSavedPermissions,
      onChange: mcp.applyBackendSettings,
      prepareConfiguration: mcp.prepareLocalAgentSetup,
      translate,
    });
    return { currentSettings, local, mcp };
  }, strict ? { wrapper: StrictMode } : undefined);
  return { ...hook, onChange };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.listSessions.mockResolvedValue([]);
  apiMocks.getMcpPermissionCatalog.mockResolvedValue([]);
  apiMocks.inspectLocalAgentSetup.mockResolvedValue(capabilities);
  apiMocks.configureLocalAgents.mockResolvedValue(configured);
  apiMocks.getAppSettings.mockResolvedValue(httpSettings);
  apiMocks.getMcpAgentPrompt.mockResolvedValue("不含凭据的通用提示词");
  apiMocks.writeText.mockResolvedValue(undefined);
  apiMocks.rotateMcpHttpToken.mockResolvedValue(undefined);
  apiMocks.updateMcpSettings.mockImplementation(async (
    mcpEnabled: boolean,
    mcpHttpEnabled: boolean,
    mcpHttpPort: number,
    mcpGroupPermissions: McpGroupPermission[],
  ) => ({ ...settings, mcpEnabled, mcpHttpEnabled, mcpHttpPort, mcpGroupPermissions }));
});

afterEach(cleanup);

describe("HTTP 本地一键配置控制器", () => {
  it("打开弹窗仅检测，不启用服务、写配置或复制凭据", async () => {
    const { result } = renderSettings();
    await act(async () => result.current.local.open("http"));
    expect(apiMocks.inspectLocalAgentSetup).toHaveBeenCalledWith("http");
    expect(result.current.local.transport).toBe("http");
    expect(result.current.local.capabilities).toEqual(capabilities);
    expect(apiMocks.updateMcpSettings).not.toHaveBeenCalled();
    expect(apiMocks.configureLocalAgents).not.toHaveBeenCalled();
    expect(apiMocks.getAppSettings).not.toHaveBeenCalled();
    expect(apiMocks.writeText).not.toHaveBeenCalled();
  });

  it("切换传输方式时丢弃上一次检测结果", async () => {
    const oldRequest = deferred<LocalAgentCapability[]>();
    apiMocks.inspectLocalAgentSetup.mockReturnValueOnce(oldRequest.promise);
    const { result } = renderSettings();
    let oldInspection!: Promise<void>;
    act(() => { oldInspection = result.current.local.open(); });
    await act(async () => result.current.local.open("http"));
    await act(async () => {
      oldRequest.resolve([]);
      await oldInspection;
    });
    expect(apiMocks.inspectLocalAgentSetup).toHaveBeenNthCalledWith(1);
    expect(apiMocks.inspectLocalAgentSetup).toHaveBeenNthCalledWith(2, "http");
    expect(result.current.local.capabilities).toEqual(capabilities);
    expect(result.current.local.transport).toBe("http");
    expect(result.current.local.loading).toBe(false);
  });

  it("端口未改时直接调用 HTTP 配置并回读后端真实开关", async () => {
    const { result, onChange } = renderSettings(true);
    await act(async () => result.current.local.open("http"));
    act(() => result.current.mcp.updatePermission("prod", { enabled: true, fileWrite: true }));
    await act(async () => result.current.local.configure(["codex"]));
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledWith(["codex"], "http");
    expect(apiMocks.updateMcpSettings).not.toHaveBeenCalled();
    expect(apiMocks.getAppSettings).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(httpSettings);
    expect(result.current.currentSettings.mcpGroupPermissions).toEqual([]);
    expect(result.current.local.results).toEqual(configured);
    expect(result.current.local.configuring).toBe(false);
    expect(apiMocks.writeText).not.toHaveBeenCalled();
  });

  it("等待失焦保存完成，使用新端口且不提交未保存权限", async () => {
    const portRequest = deferred<AppSettings>();
    const port = 41_234;
    const savedPort = { ...settings, mcpHttpPort: port };
    apiMocks.updateMcpSettings.mockReturnValueOnce(portRequest.promise);
    apiMocks.getAppSettings.mockResolvedValueOnce({ ...httpSettings, mcpHttpPort: port });
    const { result } = renderSettings();
    let portSaving!: Promise<boolean>;
    act(() => {
      result.current.mcp.updatePermission("prod", { enabled: true, fileDelete: true });
      result.current.mcp.setPort(String(port));
      portSaving = result.current.mcp.savePort();
    });
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    await act(async () => Promise.resolve());
    expect(apiMocks.configureLocalAgents).not.toHaveBeenCalled();
    expect(result.current.local.configuring).toBe(true);
    expect(apiMocks.updateMcpSettings).toHaveBeenCalledWith(false, false, port, []);

    await act(async () => {
      portRequest.resolve(savedPort);
      await portSaving;
      await configuring;
    });
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledWith(["codex"], "http");
    expect(result.current.currentSettings.mcpHttpPort).toBe(port);
    expect(result.current.mcp.port).toBe(String(port));
    expect(apiMocks.updateMcpSettings).toHaveBeenCalledTimes(1);
  });

  it("迟到的端口保存不覆盖新草稿，配置前继续保存最新草稿", async () => {
    const firstRequest = deferred<AppSettings>();
    apiMocks.updateMcpSettings.mockReturnValueOnce(firstRequest.promise);
    apiMocks.getAppSettings.mockResolvedValueOnce({ ...httpSettings, mcpHttpPort: 42_002 });
    const { result } = renderSettings();
    act(() => {
      result.current.mcp.setPort("42001");
      void result.current.mcp.savePort();
      result.current.mcp.setPort("42002");
    });
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    await act(async () => {
      firstRequest.resolve({ ...settings, mcpHttpPort: 42_001 });
      await configuring;
    });
    expect(apiMocks.updateMcpSettings).toHaveBeenNthCalledWith(1, false, false, 42_001, []);
    expect(apiMocks.updateMcpSettings).toHaveBeenNthCalledWith(2, false, false, 42_002, []);
    expect(result.current.mcp.port).toBe("42002");
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledTimes(1);
  });

  it("端口保存失败停止配置，失败后可以重新保存并恢复", async () => {
    const portRequest = deferred<AppSettings>();
    apiMocks.updateMcpSettings.mockReturnValueOnce(portRequest.promise);
    const { result } = renderSettings();
    act(() => {
      result.current.mcp.setPort("42003");
      void result.current.mcp.savePort();
    });
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    await act(async () => {
      portRequest.reject(new Error("端口保存失败"));
      await configuring;
    });
    expect(apiMocks.configureLocalAgents).not.toHaveBeenCalled();
    expect(result.current.local.error).toBe("settings.localAgentSettingsSaveFailed");
    expect(result.current.local.configuring).toBe(false);

    apiMocks.getAppSettings.mockResolvedValueOnce({ ...httpSettings, mcpHttpPort: 42_003 });
    await act(async () => result.current.local.configure(["codex"]));
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledTimes(1);
    expect(result.current.local.error).toBeNull();
    expect(result.current.mcp.port).toBe("42003");
  });

  it("非法端口只显示错误，不启用服务或写客户端配置", async () => {
    const { result } = renderSettings();
    await act(async () => result.current.local.open("http"));
    act(() => result.current.mcp.setPort("65536"));
    await act(async () => result.current.local.configure(["codex"]));
    expect(result.current.mcp.httpError).toBe("settings.mcpInvalidPort");
    expect(result.current.local.configuring).toBe(false);
    expect(apiMocks.updateMcpSettings).not.toHaveBeenCalled();
    expect(apiMocks.configureLocalAgents).not.toHaveBeenCalled();
  });

  it("等待 Token 轮换完成再开始配置", async () => {
    const tokenRequest = deferred<void>();
    apiMocks.rotateMcpHttpToken.mockReturnValueOnce(tokenRequest.promise);
    const { result } = renderSettings();
    act(() => { void result.current.mcp.rotateToken(); });
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    expect(apiMocks.configureLocalAgents).not.toHaveBeenCalled();
    await act(async () => {
      tokenRequest.resolve(undefined);
      await configuring;
    });
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledTimes(1);
  });

  it("配置期间禁止重复提交、切换传输、关闭弹窗及修改 MCP", async () => {
    const request = deferred<LocalAgentConfigureResult[]>();
    apiMocks.configureLocalAgents.mockReturnValueOnce(request.promise);
    const { result } = renderSettings();
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    await act(async () => {
      await result.current.local.configure(["codex"]);
      await result.current.local.open();
      result.current.local.cancel();
      await result.current.mcp.rotateToken();
      await result.current.mcp.save("stdio", false);
    });
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledTimes(1);
    expect(apiMocks.inspectLocalAgentSetup).toHaveBeenCalledTimes(1);
    expect(apiMocks.rotateMcpHttpToken).not.toHaveBeenCalled();
    expect(apiMocks.updateMcpSettings).not.toHaveBeenCalled();
    expect(result.current.local.dialogOpen).toBe(true);
    expect(result.current.local.transport).toBe("http");
    await act(async () => {
      request.resolve(configured);
      await configuring;
    });
    await act(async () => result.current.mcp.rotateToken());
    expect(apiMocks.rotateMcpHttpToken).toHaveBeenCalledTimes(1);
  });

  it("HTTP 写入失败仍回读实际开关，保留主错误供重试", async () => {
    apiMocks.configureLocalAgents.mockRejectedValueOnce(new Error("配置写入失败"));
    const { result } = renderSettings();
    await act(async () => result.current.local.open("http"));
    await act(async () => result.current.local.configure(["codex"]));
    expect(result.current.currentSettings).toEqual(httpSettings);
    expect(result.current.local.error).toBe("配置写入失败");
    expect(result.current.local.configuring).toBe(false);
    await act(async () => result.current.local.configure(["codex"]));
    expect(result.current.local.error).toBeNull();
    expect(result.current.local.results).toEqual(configured);
  });

  it("实际开关回读失败不抹掉客户端成功结果", async () => {
    apiMocks.getAppSettings.mockRejectedValueOnce(new Error("设置回读失败"));
    const { result } = renderSettings();
    await act(async () => result.current.local.open("http"));
    await act(async () => result.current.local.configure(["codex"]));
    expect(result.current.local.results).toEqual(configured);
    expect(result.current.local.error).toBe("设置回读失败");
    expect(result.current.currentSettings).toEqual(settings);
    expect(result.current.local.configuring).toBe(false);
  });

  it("等待端口保存期间卸载，不再启动后续配置", async () => {
    const request = deferred<AppSettings>();
    apiMocks.updateMcpSettings.mockReturnValueOnce(request.promise);
    const { result, unmount, onChange } = renderSettings();
    act(() => {
      result.current.mcp.setPort("42004");
      void result.current.mcp.savePort();
    });
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    unmount();
    request.resolve({ ...settings, mcpHttpPort: 42_004 });
    await configuring;
    expect(apiMocks.configureLocalAgents).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("卸载后丢弃配置结果，残留回调不能再发起请求", async () => {
    const request = deferred<LocalAgentConfigureResult[]>();
    apiMocks.configureLocalAgents.mockReturnValueOnce(request.promise);
    const { result, unmount, onChange } = renderSettings();
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["codex"]); });
    await act(async () => Promise.resolve());
    const previous = result.current;
    unmount();
    request.resolve(configured);
    await configuring;
    await previous.local.open();
    await previous.local.configure(["codex"]);
    await previous.mcp.save("stdio", true);
    await previous.mcp.rotateToken();
    expect(apiMocks.configureLocalAgents).toHaveBeenCalledTimes(1);
    expect(apiMocks.inspectLocalAgentSetup).toHaveBeenCalledTimes(1);
    expect(apiMocks.getAppSettings).not.toHaveBeenCalled();
    expect(apiMocks.updateMcpSettings).not.toHaveBeenCalled();
    expect(apiMocks.rotateMcpHttpToken).not.toHaveBeenCalled();
    expect(apiMocks.writeText).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("提示词读取期间卸载，不进行迟到的剪贴板写入", async () => {
    const promptRequest = deferred<string>();
    apiMocks.configureLocalAgents.mockResolvedValueOnce([
      { ...configured[0], target: "cursor", promptStatus: "manualRequired" },
    ]);
    apiMocks.getMcpAgentPrompt.mockReturnValueOnce(promptRequest.promise);
    const { result, unmount } = renderSettings();
    await act(async () => result.current.local.open("http"));
    let configuring!: Promise<void>;
    act(() => { configuring = result.current.local.configure(["cursor"]); });
    await act(async () => Promise.resolve());
    expect(apiMocks.getMcpAgentPrompt).toHaveBeenCalledTimes(1);
    unmount();
    promptRequest.resolve("迟到提示词");
    await configuring;
    expect(apiMocks.writeText).not.toHaveBeenCalled();
  });
});
