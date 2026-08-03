// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import type { AppUpdaterController } from "./useAppUpdater";
import { SettingsPage } from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  configureLocalAgents: vi.fn(),
  getMcpAgentPrompt: vi.fn(),
  getMcpPermissionCatalog: vi.fn(),
  inspectLocalAgentSetup: vi.fn(),
  listSessions: vi.fn(),
  updateMcpSettings: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    configureLocalAgents: mocks.configureLocalAgents,
    getMcpAgentPrompt: mocks.getMcpAgentPrompt,
    getMcpPermissionCatalog: mocks.getMcpPermissionCatalog,
    inspectLocalAgentSetup: mocks.inspectLocalAgentSetup,
    listSessions: mocks.listSessions,
    updateMcpSettings: mocks.updateMcpSettings,
  },
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
  mcpEnabled: false,
  mcpGroupPermissions: [],
  mcpHttpEnabled: false,
  mcpHttpPort: 37_653,
  updateProxy: "",
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
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentConfigure" }));

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
});
