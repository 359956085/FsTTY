// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import type { AppUpdaterController } from "./useAppUpdater";
import { SettingsPage } from "./SettingsPage";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";

const mocks = vi.hoisted(() => ({
  configureLocalAgents: vi.fn(),
  clearCommandHistory: vi.fn(),
  confirm: vi.fn(),
  exportCommandHistory: vi.fn(),
  getCommandHistorySettings: vi.fn().mockResolvedValue({
    deduplicate: false,
    duplicateCount: 0,
    entryCount: 0,
  }),
  getMcpHttpClientConfig: vi.fn(),
  getMcpAgentPrompt: vi.fn(),
  getMcpPermissionCatalog: vi.fn(),
  getMcpStdioClientConfig: vi.fn(),
  inspectLocalAgentSetup: vi.fn(),
  importCommandHistory: vi.fn(),
  listSessions: vi.fn(),
  openProjectLink: vi.fn(),
  updateMcpSettings: vi.fn(),
  updateLogSettings: vi.fn(),
  updateAppSettings: vi.fn(),
  updateShortcutSettings: vi.fn(),
  updateCommandHistoryDeduplication: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    configureLocalAgents: mocks.configureLocalAgents,
    clearCommandHistory: mocks.clearCommandHistory,
    exportCommandHistory: mocks.exportCommandHistory,
    getCommandHistorySettings: mocks.getCommandHistorySettings,
    getMcpHttpClientConfig: mocks.getMcpHttpClientConfig,
    getMcpAgentPrompt: mocks.getMcpAgentPrompt,
    getMcpPermissionCatalog: mocks.getMcpPermissionCatalog,
    getMcpStdioClientConfig: mocks.getMcpStdioClientConfig,
    inspectLocalAgentSetup: mocks.inspectLocalAgentSetup,
    importCommandHistory: mocks.importCommandHistory,
    listSessions: mocks.listSessions,
    openProjectLink: mocks.openProjectLink,
    updateMcpSettings: mocks.updateMcpSettings,
    updateCommandHistoryDeduplication: mocks.updateCommandHistoryDeduplication,
    updateLogSettings: mocks.updateLogSettings,
    updateAppSettings: mocks.updateAppSettings,
    updateShortcutSettings: mocks.updateShortcutSettings,
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.confirm,
  open: mocks.open,
  save: mocks.save,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeText,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" },
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

const updater: AppUpdaterController = {
  availableUpdate: null,
  busy: false,
  checkForUpdates: vi.fn().mockResolvedValue(undefined),
  currentVersion: "1.0.0",
  dialogOpen: false,
  dismissUpdate: vi.fn().mockResolvedValue(undefined),
  downloadedBytes: 0,
  error: null,
  ignoreError: false,
  ignoreUpdate: vi.fn().mockResolvedValue(undefined),
  installUpdate: vi.fn().mockResolvedValue(undefined),
  phase: "idle",
  totalBytes: null,
  versionError: null,
};

describe("SettingsPage 本地 Agent 配置", () => {
  it("日志分组保存 MCP 工具输入开关并阻止重复提交", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    let finishSave: ((value: AppSettings) => void) | undefined;
    mocks.updateLogSettings.mockImplementation(
      () =>
        new Promise<AppSettings>((resolve) => {
          finishSave = resolve;
        }),
    );
    const onChange = vi.fn();
    render(<SettingsPage onChange={onChange} settings={settings} updater={updater} />);

    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      "settings.generalSettings",
      "settings.shortcuts",
      "settings.commandHistory",
      "settings.logs",
    ]);
    const generalPanel = screen
      .getByRole("heading", { name: "settings.generalSettings" })
      .closest("section");
    const logPanel = screen.getByRole("heading", { name: "settings.logs" }).closest("section");
    expect(generalPanel).not.toBeNull();
    expect(logPanel).not.toBeNull();
    expect(within(generalPanel!).queryByText("settings.logDirectory")).toBeNull();
    const logDirectoryLabel = within(logPanel!).getByText("settings.logDirectory");
    const recordInputsLabel = within(logPanel!).getByText("settings.recordMcpToolInputs");
    const logDirectoryRow = logDirectoryLabel.closest(".settings-row");
    const recordInputsRow = recordInputsLabel.closest(".settings-row");
    expect(logDirectoryRow?.className).toBe("settings-row");
    expect(recordInputsRow?.className).toBe("settings-row settings-log-row");
    expect(logDirectoryRow?.nextElementSibling).toBe(recordInputsRow);
    expect(
      within(logPanel!).getByRole("button", { name: "settings.openLogDirectory" }),
    ).not.toBeNull();
    const switchElement = screen.getByRole("switch", {
      name: "settings.recordMcpToolInputs",
    }) as HTMLInputElement;
    expect(switchElement.checked).toBe(false);
    fireEvent.click(switchElement);
    await waitFor(() => expect(switchElement.disabled).toBe(true));
    fireEvent.click(switchElement);
    expect(mocks.updateLogSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateLogSettings).toHaveBeenCalledWith(true);

    const enabledSettings = { ...settings, recordMcpToolInputs: true };
    finishSave?.(enabledSettings);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(enabledSettings));
  });

  it("关于页展示项目、邮箱和当前版本并支持打开项目与复制邮箱", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.openProjectLink.mockResolvedValue(undefined);
    mocks.writeText.mockResolvedValue(undefined);
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    expect(screen.queryByText("v1.0.0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "settings.about" }));

    expect(screen.getByText("v1.0.0")).not.toBeNull();
    const projectButton = screen.getByRole("button", {
      name: "https://github.com/359956085/FsTTY",
    });
    const emailButton = screen.getByRole("button", { name: "359956085@163.com" });
    fireEvent.click(projectButton);
    fireEvent.click(emailButton);

    await waitFor(() => expect(mocks.openProjectLink).toHaveBeenCalledTimes(1));
    expect(mocks.writeText).toHaveBeenCalledWith("359956085@163.com");

    fireEvent.click(screen.getByRole("button", { name: "settings.viewUpdateHistory" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("v1.2.1")).toBeTruthy();
  });

  it("关于页保存 GitHub 更新源", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    const nextSettings = { ...settings, updateSource: "github" as const };
    mocks.updateAppSettings.mockResolvedValue(nextSettings);
    const onChange = vi.fn();
    render(<SettingsPage onChange={onChange} settings={settings} updater={updater} />);
    fireEvent.click(screen.getByRole("button", { name: "settings.about" }));

    fireEvent.click(screen.getByRole("combobox", { name: "settings.updateSource" }));
    fireEvent.click(screen.getByRole("option", { name: "GitHub" }));

    await waitFor(() =>
      expect(mocks.updateAppSettings).toHaveBeenCalledWith(false, "", false, "github"),
    );
    expect(onChange).toHaveBeenCalledWith(nextSettings);
  });

  it("日志设置保存失败后恢复开关并显示错误", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.updateLogSettings.mockRejectedValue(new Error("保存失败"));
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    const switchElement = screen.getByRole("switch", {
      name: "settings.recordMcpToolInputs",
    }) as HTMLInputElement;
    fireEvent.click(switchElement);

    expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
    expect(switchElement.checked).toBe(false);
    await waitFor(() => expect(switchElement.disabled).toBe(false));
  });

  it("将提示词放入 stdio 和 HTTP，并为 stdio 单列一键设置", () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpTitle" }));

    expect(screen.queryByRole("heading", { name: "settings.mcpPrompt" })).toBeNull();
    const stdioPanel = screen
      .getByRole("heading", { name: "settings.mcpEnabled" })
      .closest("section");
    const httpPanel = screen.getByRole("heading", { name: "settings.mcpHttp" }).closest("section");
    expect(stdioPanel).not.toBeNull();
    expect(httpPanel).not.toBeNull();
    expect(within(stdioPanel!).getByText("settings.mcpAgentPrompt")).not.toBeNull();
    expect(within(httpPanel!).getByText("settings.mcpAgentPrompt")).not.toBeNull();
    expect(within(stdioPanel!).getByText("settings.localAgentSetup")).not.toBeNull();
    expect(
      within(stdioPanel!).getByRole("button", { name: "settings.localAgentOpen" }),
    ).not.toBeNull();
    expect(
      within(httpPanel!).queryByRole("button", { name: "settings.localAgentOpen" }),
    ).toBeNull();
    expect(
      within(stdioPanel!).getByRole("button", { name: "settings.mcpCopyConfig" }),
    ).not.toBeNull();
    expect(
      within(httpPanel!).getByRole("button", { name: "settings.mcpCopyConfig" }),
    ).not.toBeNull();
  });

  it("stdio 和 HTTP 配置均可选择 dsh 并显示对应提示", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.getMcpStdioClientConfig.mockResolvedValue("dsh stdio config");
    mocks.getMcpHttpClientConfig.mockResolvedValue("dsh http config");
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpTitle" }));
    const stdioPanel = screen
      .getByRole("heading", { name: "settings.mcpEnabled" })
      .closest("section");
    const httpPanel = screen.getByRole("heading", { name: "settings.mcpHttp" }).closest("section");
    expect(stdioPanel).not.toBeNull();
    expect(httpPanel).not.toBeNull();

    fireEvent.click(
      within(stdioPanel!).getByRole("button", { name: "settings.mcpCopyConfig" }),
    );
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "settings.mcpClient" }));
    fireEvent.click(screen.getByRole("option", { name: "dsh (DeepSeek Harness)" }));
    await waitFor(() => expect(mocks.getMcpStdioClientConfig).toHaveBeenCalledWith("dsh"));
    expect(within(dialog).getByText("settings.mcpDshConfigHint")).not.toBeNull();
    expect(within(dialog).queryByText("settings.mcpConfigSecretHint")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(
      within(httpPanel!).getByRole("button", { name: "settings.mcpCopyConfig" }),
    );
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "settings.mcpClient" }));
    fireEvent.click(screen.getByRole("option", { name: "dsh (DeepSeek Harness)" }));
    await waitFor(() => expect(mocks.getMcpHttpClientConfig).toHaveBeenCalledWith("dsh"));
    expect(within(dialog).getByText("settings.mcpDshConfigHint")).not.toBeNull();
    expect(within(dialog).getByText("settings.mcpConfigSecretHint")).not.toBeNull();
  });

  it("stdio 和 HTTP 独立复制同一份提示词", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.getMcpAgentPrompt.mockResolvedValue("FsTTY prompt");
    mocks.writeText.mockResolvedValue(undefined);
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpTitle" }));
    const stdioPanel = screen
      .getByRole("heading", { name: "settings.mcpEnabled" })
      .closest("section");
    const httpPanel = screen.getByRole("heading", { name: "settings.mcpHttp" }).closest("section");
    expect(stdioPanel).not.toBeNull();
    expect(httpPanel).not.toBeNull();

    fireEvent.click(
      within(stdioPanel!).getByRole("button", { name: "settings.mcpCopyPrompt" }),
    );
    await waitFor(() =>
      expect(
        within(stdioPanel!).getByRole("button", { name: "settings.mcpPromptCopied" }),
      ).not.toBeNull(),
    );
    expect(
      within(httpPanel!).getByRole("button", { name: "settings.mcpCopyPrompt" }),
    ).not.toBeNull();

    fireEvent.click(
      within(httpPanel!).getByRole("button", { name: "settings.mcpCopyPrompt" }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(2));
    expect(mocks.getMcpAgentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.writeText).toHaveBeenNthCalledWith(1, "FsTTY prompt");
    expect(mocks.writeText).toHaveBeenNthCalledWith(2, "FsTTY prompt");
    expect(
      within(httpPanel!).getByRole("button", { name: "settings.mcpPromptCopied" }),
    ).not.toBeNull();
  });

  it("先启用 stdio，再配置所选 Agent，并复制 Cursor 提示词", async () => {
    const enabledSettings = { ...settings, mcpEnabled: true };
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.inspectLocalAgentSetup.mockResolvedValue([
      { detail: null, installed: true, state: "missing", target: "cursor" },
    ]);
    mocks.updateMcpSettings.mockResolvedValue(enabledSettings);
    mocks.configureLocalAgents.mockResolvedValue([
      {
        mcpStatus: "configured",
        promptStatus: "manualRequired",
        message: null,
        target: "cursor",
      },
    ]);
    mocks.getMcpAgentPrompt.mockResolvedValue("FsTTY prompt");
    mocks.writeText.mockResolvedValue(undefined);
    const onChange = vi.fn();
    render(<SettingsPage onChange={onChange} settings={settings} updater={updater} />);

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpTitle" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentOpen" }));
    await screen.findByRole("checkbox", { name: /Cursor/ });
    const configureButton = screen.getByRole("button", {
      name: "settings.localAgentConfigure",
    }) as HTMLButtonElement;
    await waitFor(() => expect(configureButton.disabled).toBe(false));
    fireEvent.click(configureButton);

    await waitFor(() => expect(mocks.configureLocalAgents).toHaveBeenCalledWith(["cursor"]));
    expect(mocks.updateMcpSettings).toHaveBeenCalledWith(true, false, 37_653, []);
    expect(mocks.updateMcpSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.configureLocalAgents.mock.invocationCallOrder[0],
    );
    expect(onChange).toHaveBeenCalledWith(enabledSettings);
    expect(mocks.writeText).toHaveBeenCalledWith("FsTTY prompt");
    expect(screen.getByText("settings.localAgentCursorPromptCopied")).not.toBeNull();
  });

  it("多个手工提示词 Agent 只复制一次并分别展示提示", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.inspectLocalAgentSetup.mockResolvedValue([
      { detail: null, installed: true, state: "missing", target: "cursor" },
      { detail: null, installed: true, state: "missing", target: "trae" },
      { detail: null, installed: true, state: "missing", target: "traeCn" },
    ]);
    mocks.configureLocalAgents.mockResolvedValue([
      {
        mcpStatus: "configured",
        promptStatus: "manualRequired",
        message: null,
        target: "cursor",
      },
      {
        mcpStatus: "configured",
        promptStatus: "manualRequired",
        message: null,
        target: "trae",
      },
      {
        mcpStatus: "configured",
        promptStatus: "manualRequired",
        message: null,
        target: "traeCn",
      },
    ]);
    mocks.getMcpAgentPrompt.mockResolvedValue("FsTTY prompt");
    mocks.writeText.mockResolvedValue(undefined);
    render(
      <SettingsPage
        onChange={vi.fn()}
        settings={{ ...settings, mcpEnabled: true }}
        updater={updater}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpTitle" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentOpen" }));
    await screen.findByRole("checkbox", { name: /Trae CN/ });
    const configureButton = screen.getByRole("button", {
      name: "settings.localAgentConfigure",
    }) as HTMLButtonElement;
    await waitFor(() => expect(configureButton.disabled).toBe(false));
    fireEvent.click(configureButton);

    await screen.findByText("settings.localAgentTraeCnPromptCopied");
    expect(mocks.configureLocalAgents).toHaveBeenCalledWith(["cursor", "trae", "traeCn"]);
    expect(mocks.getMcpAgentPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByText("settings.localAgentCursorPromptCopied")).not.toBeNull();
    expect(screen.getByText("settings.localAgentTraePromptCopied")).not.toBeNull();
  });

  it("多个手工提示词 Agent 剪贴板失败不回滚已完成的 MCP 配置", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.inspectLocalAgentSetup.mockResolvedValue([
      { detail: null, installed: true, state: "missing", target: "cursor" },
      { detail: null, installed: true, state: "missing", target: "trae" },
    ]);
    mocks.configureLocalAgents.mockResolvedValue([
      {
        mcpStatus: "configured",
        promptStatus: "manualRequired",
        message: null,
        target: "cursor",
      },
      {
        mcpStatus: "configured",
        promptStatus: "manualRequired",
        message: null,
        target: "trae",
      },
    ]);
    mocks.getMcpAgentPrompt.mockResolvedValue("FsTTY prompt");
    mocks.writeText.mockRejectedValue(new Error("clipboard denied"));
    render(
      <SettingsPage
        onChange={vi.fn()}
        settings={{ ...settings, mcpEnabled: true }}
        updater={updater}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpTitle" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentOpen" }));
    await screen.findByRole("checkbox", { name: /Cursor/ });
    const configureButton = screen.getByRole("button", {
      name: "settings.localAgentConfigure",
    }) as HTMLButtonElement;
    await waitFor(() => expect(configureButton.disabled).toBe(false));
    fireEvent.click(configureButton);

    await waitFor(() => expect(screen.getAllByText("settings.localAgentFailed")).toHaveLength(2));
    expect(mocks.configureLocalAgents).toHaveBeenCalledWith(["cursor", "trae"]);
    expect(mocks.updateMcpSettings).not.toHaveBeenCalled();
    expect(screen.getAllByText("clipboard denied")).toHaveLength(2);
    expect(mocks.getMcpAgentPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.writeText).toHaveBeenCalledTimes(1);
  });

  it("历史命令分组确认后开启去重并保留导入导出清空顺序", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.getCommandHistorySettings.mockResolvedValue({
      deduplicate: false,
      duplicateCount: 2,
      entryCount: 5,
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.updateCommandHistoryDeduplication.mockResolvedValue({
      deduplicate: true,
      duplicateCount: 0,
      entryCount: 3,
    });
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    const panel = screen
      .getByRole("heading", { name: "settings.commandHistory" })
      .closest("section");
    expect(panel).not.toBeNull();
    const historySwitch = await within(panel!).findByRole("switch", {
      name: "settings.commandHistoryDedupe",
    });
    await waitFor(() => expect((historySwitch as HTMLInputElement).disabled).toBe(false));
    const buttons = within(panel!)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(buttons).toEqual([
      "settings.commandHistoryImport",
      "settings.commandHistoryExport",
      "settings.commandHistoryClear",
    ]);
    fireEvent.click(historySwitch);

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.updateCommandHistoryDeduplication).toHaveBeenCalledWith(true),
    );
    await waitFor(() => expect((historySwitch as HTMLInputElement).checked).toBe(true));
  });

  it("历史命令去重保存失败时开关保持原值", async () => {
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.getCommandHistorySettings.mockResolvedValue({
      deduplicate: false,
      duplicateCount: 1,
      entryCount: 2,
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.updateCommandHistoryDeduplication.mockRejectedValue(new Error("去重保存失败"));
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    const historySwitch = await screen.findByRole("switch", {
      name: "settings.commandHistoryDedupe",
    });
    await waitFor(() => expect((historySwitch as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(historySwitch);

    expect((await screen.findByRole("alert")).textContent).toContain("去重保存失败");
    expect((historySwitch as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect((historySwitch as HTMLInputElement).disabled).toBe(false));
  });

  it("历史命令支持导入、导出和确认清空", async () => {
    const historySettings = { deduplicate: false, duplicateCount: 0, entryCount: 2 };
    mocks.listSessions.mockResolvedValue([]);
    mocks.getMcpPermissionCatalog.mockResolvedValue([]);
    mocks.getCommandHistorySettings.mockResolvedValue(historySettings);
    mocks.open.mockResolvedValue("C:\\history.json");
    mocks.importCommandHistory.mockResolvedValue({ importedCount: 2, mergedCount: 0, totalCount: 4 });
    mocks.save.mockResolvedValue("C:\\export.json");
    mocks.exportCommandHistory.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(true);
    mocks.clearCommandHistory.mockResolvedValue({
      deduplicate: false,
      duplicateCount: 0,
      entryCount: 0,
    });
    render(<SettingsPage onChange={vi.fn()} settings={settings} updater={updater} />);

    const panel = screen
      .getByRole("heading", { name: "settings.commandHistory" })
      .closest("section");
    expect(panel).not.toBeNull();
    const historySwitch = await within(panel!).findByRole("switch", {
      name: "settings.commandHistoryDedupe",
    });
    await waitFor(() => expect((historySwitch as HTMLInputElement).disabled).toBe(false));

    fireEvent.click(
      within(panel!).getByRole("button", { name: "settings.commandHistoryImport" }),
    );
    await waitFor(() => expect(mocks.importCommandHistory).toHaveBeenCalledWith("C:\\history.json"));

    fireEvent.click(
      within(panel!).getByRole("button", { name: "settings.commandHistoryExport" }),
    );
    await waitFor(() => expect(mocks.exportCommandHistory).toHaveBeenCalledWith("C:\\export.json"));

    fireEvent.click(
      within(panel!).getByRole("button", { name: "settings.commandHistoryClear" }),
    );
    await waitFor(() => expect(mocks.clearCommandHistory).toHaveBeenCalledTimes(1));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
});
