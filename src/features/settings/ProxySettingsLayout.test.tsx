// 浏览器环境：@vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AppSettings } from "../../shared/api/types";
import i18n from "../../shared/i18n";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { AboutSettingsPanel } from "./AboutSettingsPanel";
import type { AppUpdaterController } from "./useAppUpdater";

const locale = vi.hoisted(() => ({ language: "zh-CN" }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: i18n.getFixedT(locale.language) }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("./ShortcutSettingsSection", () => ({ ShortcutSettingsSection: () => null }));
vi.mock("./CommandHistorySettingsSection", () => ({ CommandHistorySettingsSection: () => null }));
vi.mock("./CredentialSecuritySection", () => ({ CredentialSecuritySection: () => null }));
vi.mock("./useAutostartSettings", () => ({ useAutostartSettings: () => ({
  confirmed: true, enabled: false, error: null, loading: false, saving: false, refresh: vi.fn(), save: vi.fn(),
}) }));

const settings: AppSettings = {
  language: "zh-CN", theme: "system", terminalColorScheme: "default", autoUpdate: true, updateSource: "auto", proxyAddress: "", proxyEnabled: false,
  allowRemoteClipboardWrite: true, recordMcpToolInputs: false, ignoredUpdateVersion: null,
  mcpEnabled: false, mcpHttpEnabled: false, mcpHttpPort: 37653, mcpGroupPermissions: [],
  shortcuts: DEFAULT_SHORTCUTS,
};

function general(overrides: Partial<ComponentProps<typeof GeneralSettingsPanel>> = {}) {
  return render(<GeneralSettingsPanel
    activeTooltipKey={null} logDirectoryError={null} logSettingsError={null}
    onClipboardChange={vi.fn()} onHideTooltip={vi.fn()} onLanguageChange={vi.fn()} onThemeChange={vi.fn()}
    onTerminalColorSchemeChange={vi.fn()} savingTerminalColorScheme={false}
    onOpenLogDirectory={vi.fn()} onRecordMcpToolInputsChange={vi.fn()} onShowTooltip={vi.fn()}
    onSettingsChange={vi.fn()} openingLogDirectory={false} savingLanguage={false} savingTheme={false}
    savingLogSettings={false} savingUpdateSettings={false} settings={settings}
    onProxyChange={vi.fn()} onProxyCommit={vi.fn()} onProxyEnabledChange={vi.fn()} proxy="" proxyError={null} savingProxy={false}
    {...overrides}
  />);
}
afterEach(() => { cleanup(); locale.language = "zh-CN"; });

describe("全局代理及应用更新布局", () => {
  it.each(["zh-CN", "en-US"])("文字配色可独立选择，保存时禁用配色和主题：%s", (language) => {
    locale.language = language;
    const t = i18n.getFixedT(language);
    const onTerminalColorSchemeChange = vi.fn();
    const onThemeChange = vi.fn();
    const { unmount } = general({ onTerminalColorSchemeChange, onThemeChange });
    fireEvent.click(screen.getByRole("combobox", { name: t("settings.terminalColorScheme") }));
    expect(screen.getAllByRole("option")).toHaveLength(11);
    fireEvent.click(screen.getByRole("option", { name: "Rosé Pine" }));
    expect(onTerminalColorSchemeChange).toHaveBeenCalledExactlyOnceWith("rosePine");
    expect(onThemeChange).not.toHaveBeenCalled();
    unmount();
    general({ savingTerminalColorScheme: true });
    expect((screen.getByRole("combobox", { name: t("settings.terminalColorScheme") }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: t("settings.theme") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["zh-CN", "en-US"])("代理独立放在基础设置下方，更新顺序准确：%s", (language) => {
    locale.language = language;
    const t = i18n.getFixedT(language);
    const { unmount } = general();
    const proxy = screen.getByRole("textbox", { name: t("settings.proxyAddress") });
    const basic = screen.getByRole("heading", { name: t("settings.generalSettings") }).closest("section");
    const group = screen.getByRole("heading", { name: t("settings.proxyTitle") }).closest("section");
    expect(basic?.nextElementSibling).toBe(group);
    expect(group?.contains(proxy)).toBe(true);
    expect(basic?.contains(proxy)).toBe(false);
    expect((screen.getByRole("switch", { name: t("settings.proxyEnable") }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(t("settings.proxyAddressHint"))).toBeTruthy();
    expect(proxy.getAttribute("placeholder")).toBe("http://127.0.0.1:7890");
    unmount();
    const onAutoUpdateChange = vi.fn();
    render(<AboutSettingsPanel error={null} onAutoUpdateChange={onAutoUpdateChange}
      onCheckUpdates={vi.fn()} onUpdateSourceChange={vi.fn()} savingUpdateSettings={false}
      settings={settings} status={null}
      updater={{ busy: false, currentVersion: "1.4.0", phase: "idle" } as AppUpdaterController} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    const update = screen.getByRole("heading", { name: t("settings.appUpdate") }).closest("section");
    expect(Array.from(update?.querySelectorAll(".settings-row-label") ?? [], (row) => row.textContent))
      .toEqual(["checkUpdate", "autoUpdate", "updateSource", "updateHistory"].map((key) => t(`settings.${key}`)));
    const toggle = screen.getByRole("switch", { name: t("settings.autoUpdate") }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(onAutoUpdateChange).toHaveBeenCalledWith(false);
  });

  it("代理输入沿用失焦与 Enter 保存，不改变聚焦逻辑", () => {
    const onProxyChange = vi.fn();
    const onProxyCommit = vi.fn();
    general({ onProxyChange, onProxyCommit });
    const input = screen.getByRole("textbox", { name: "地址" });
    fireEvent.change(input, { target: { value: "http://127.0.0.1:7890" } });
    expect(onProxyChange).toHaveBeenCalledWith("http://127.0.0.1:7890");
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onProxyCommit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);
    input.focus();
    fireEvent.blur(input);
    expect(onProxyCommit).toHaveBeenCalledTimes(2);
  });

  it("代理保存状态和错误留在代理分组，忙时禁用输入及开关", () => {
    general({ savingProxy: true, proxyError: "地址无效", proxy: "http://bad:0" });
    const input = screen.getByRole("textbox", { name: "地址" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "开启" }) as HTMLInputElement).disabled).toBe(true);
    expect(input.value).toBe("http://bad:0");
    expect(screen.getByText("正在保存代理地址…").closest("section")).toBe(input.closest("section"));
    expect(screen.getByRole("alert").textContent).toBe("地址无效");
    expect(screen.getByRole("alert").closest("section")).toBe(input.closest("section"));
  });

  it("关闭时地址可编辑，开关立即提交开启请求", () => {
    const onProxyEnabledChange = vi.fn();
    general({ onProxyEnabledChange, proxy: "socks5://127.0.0.1:1080" });
    expect((screen.getByRole("textbox", { name: "地址" }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "开启" }));
    expect(onProxyEnabledChange).toHaveBeenCalledWith(true);
  });
});
