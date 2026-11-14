// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  terminalColorScheme: "default",
  terminalFontSize: 13, fontFamily: "default",
  mcpEnabled: false,
  mcpGroupPermissions: [],
  mcpHttpEnabled: false,
  mcpHttpPort: 37_653,
  recordMcpToolInputs: false,
  proxyAddress: "",
  proxyEnabled: false,
  updateSource: "auto",
  shortcuts: DEFAULT_SHORTCUTS,
};

describe("常规设置分组顺序", () => {
  it("凭据管理仅出现一次，位于历史命令下方、日志上方", () => {
    const changeFont = vi.fn();
    const changeTheme = vi.fn();
    render(<GeneralSettingsPanel
      activeTooltipKey={null}
      logDirectoryError={null}
      logSettingsError={null}
      onClipboardChange={vi.fn()}
      onProxyChange={vi.fn()}
      onProxyCommit={vi.fn()}
      onProxyEnabledChange={vi.fn()}
      proxy=""
      proxyError={null}
      savingProxy={false}
      onHideTooltip={vi.fn()}
      onLanguageChange={vi.fn()}
      onThemeChange={changeTheme}
      onTerminalColorSchemeChange={vi.fn()}
      onOpenLogDirectory={vi.fn()}
      onRecordMcpToolInputsChange={vi.fn()}
      onShowTooltip={vi.fn()}
      onSettingsChange={vi.fn()}
      openingLogDirectory={false}
      savingLanguage={false}
      savingTheme={false}
      savingTerminalColorScheme={false}
      savingLogSettings={false}
      savingUpdateSettings={false}
      settings={settings}
      onFontFamilyChange={changeFont}
    />);
    const history = screen.getByRole("heading", { name: "历史命令" }).closest("section");
    const credentials = screen.getByRole("heading", { name: "security.managementTitle" }).closest("section");
    const logs = screen.getByRole("heading", { name: "settings.logs" }).closest("section");
    expect(history?.nextElementSibling).toBe(credentials);
    expect(credentials?.nextElementSibling).toBe(logs);
    expect(screen.getAllByText("security.title")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "security.title" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("switch", { name: "settings.localHighlight" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("settings.localHighlightHint")).toBeTruthy();
    const font = screen.getByRole("combobox", { name: "settings.font" });
    expect(screen.getByText("settings.fontHint")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "settings.theme" }).closest(".settings-row")?.nextElementSibling).toBe(font.closest(".settings-row"));
    font.focus();
    fireEvent.click(font);
    fireEvent.keyDown(font, { key: "ArrowDown" });
    fireEvent.keyDown(font, { key: "Enter" });
    expect(changeFont).toHaveBeenCalledWith("jetBrainsMono");
    expect(document.activeElement).toBe(font);
    const proxy = screen.getByRole("textbox", { name: "settings.proxyAddress" });
    const basic = screen.getByRole("heading", { name: "settings.generalSettings" }).closest("section");
    const group = screen.getByRole("heading", { name: "settings.proxyTitle" }).closest("section");
    expect(proxy.closest("section")).toBe(group);
    expect(basic?.nextElementSibling).toBe(group);
    expect(screen.queryByRole("heading", { name: "installation.title" })).toBeNull();
    expect(screen.getAllByRole("textbox", { name: "settings.proxyAddress" })).toHaveLength(1);
    const theme = screen.getByRole("combobox", { name: "settings.theme" });
    theme.focus();
    fireEvent.click(theme);
    expect(screen.getAllByRole("option")).toHaveLength(8);
    fireEvent.click(screen.getByRole("option", { name: "settings.themeIridescentGlass" }));
    expect(changeTheme).toHaveBeenLastCalledWith("iridescentGlass");
    expect(document.activeElement).toBe(theme);
    fireEvent.click(theme);
    for (let index = 0; index < 7; index++) fireEvent.keyDown(theme, { key: "ArrowDown" });
    fireEvent.keyDown(theme, { key: "Enter" });
    expect(changeTheme).toHaveBeenLastCalledWith("iceGlass");
    expect(document.activeElement).toBe(theme);
  });
});
