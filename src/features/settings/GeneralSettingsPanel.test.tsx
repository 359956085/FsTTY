// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => true }));
vi.mock("./useAutostartSettings", () => ({ useAutostartSettings: () => ({
  confirmed: true, enabled: false, error: null, loading: false, saving: false,
  refresh: vi.fn(), save: vi.fn(),
}) }));
vi.mock("./InstallationSection", () => ({ InstallationSection: () => null }));
vi.mock("./ShortcutSettingsSection", () => ({ ShortcutSettingsSection: () => null }));
vi.mock("./CommandHistorySettingsSection", () => ({ CommandHistorySettingsSection: () => (
  <section className="settings-panel"><h3>历史命令</h3></section>
) }));

afterEach(cleanup);

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
  proxyAddress: "",
  updateSource: "auto",
  shortcuts: DEFAULT_SHORTCUTS,
};

describe("常规设置分组顺序", () => {
  it("凭据管理仅出现一次，位于历史命令下方、日志上方", () => {
    render(<GeneralSettingsPanel
      activeTooltipKey={null}
      logDirectoryError={null}
      logSettingsError={null}
      onClipboardChange={vi.fn()}
      onProxyChange={vi.fn()}
      onProxyCommit={vi.fn()}
      proxy=""
      proxyError={null}
      savingProxy={false}
      onHideTooltip={vi.fn()}
      onLanguageChange={vi.fn()}
      onThemeChange={vi.fn()}
      onOpenLogDirectory={vi.fn()}
      onRecordMcpToolInputsChange={vi.fn()}
      onShowTooltip={vi.fn()}
      onSettingsChange={vi.fn()}
      openingLogDirectory={false}
      savingLanguage={false}
      savingTheme={false}
      savingLogSettings={false}
      savingUpdateSettings={false}
      settings={settings}
    />);
    const history = screen.getByRole("heading", { name: "历史命令" }).closest("section");
    const credentials = screen.getByRole("heading", { name: "security.managementTitle" }).closest("section");
    const logs = screen.getByRole("heading", { name: "settings.logs" }).closest("section");
    expect(history?.nextElementSibling).toBe(credentials);
    expect(credentials?.nextElementSibling).toBe(logs);
    expect(screen.getAllByText("security.title")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "security.title" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const proxy = screen.getByRole("textbox", { name: "settings.proxyAddress" });
    const basic = screen.getByRole("heading", { name: "settings.generalSettings" }).closest("section");
    expect(proxy.closest("section")).toBe(basic);
    expect(basic?.querySelector(".settings-row:last-child")?.contains(proxy)).toBe(true);
    expect(screen.getAllByRole("textbox", { name: "settings.proxyAddress" })).toHaveLength(1);
  });
});
