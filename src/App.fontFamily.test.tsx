// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, FontFamilyPreference } from "./shared/api/types";
import { DEFAULT_SHORTCUTS } from "./shared/shortcuts";
import { App } from "./App";

const mocks = vi.hoisted(() => ({ get: vi.fn(), font: vi.fn(), size: vi.fn() }));
vi.mock("./shared/api/client", () => ({ api: {
  getAppSettings: mocks.get, setFontFamily: mocks.font, setTerminalFontSize: mocks.size,
} }));
vi.mock("./features/settings/useAppUpdater", () => ({ useAppUpdater: () => ({ phase: "idle" }) }));
vi.mock("./features/settings/UpdateDialog", () => ({ UpdateDialog: () => null }));
vi.mock("./features/lightweight/lightweightMode", () => ({
  getInitialLightweightModeState: () => ({ active: false, suppressConfirmation: false, phase: "normal" }),
  enterLightweightMode: vi.fn(),
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  const i18n = { t, changeLanguage: vi.fn() };
  return { useTranslation: () => ({ t, i18n }) };
});
vi.mock("./features/sessions/SessionsPage", () => ({ SessionsPage: (props: {
  fontFamily: FontFamilyPreference; terminalFontSize: number; onTerminalFontSizeAdjust?: (step: number) => void;
}) => <div>
  <span data-testid="effective-font">{props.fontFamily}</span>
  <span data-testid="terminal-size">{props.terminalFontSize}</span>
  <button onClick={() => props.onTerminalFontSizeAdjust?.(1)}>wheel up</button>
</div> }));
vi.mock("./features/settings/SettingsPage", () => ({ SettingsPage: (props: {
  settings: AppSettings; onChange: (settings: AppSettings) => void; onFontFamilyChange?: (font: FontFamilyPreference) => void;
}) => <div>
  <span data-testid="theme">{props.settings.theme}</span>
  <button onClick={() => props.onFontFamilyChange?.("consolas")}>select Consolas</button>
  <button onClick={() => props.onChange({ ...props.settings, theme: "dark", fontFamily: "default", terminalFontSize: 13 })}>other setting response</button>
</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.removeAttribute("style"); });

const settings: AppSettings = {
  language: "zh-CN", theme: "light", fontFamily: "default", terminalColorScheme: "default", terminalFontSize: 13,
  autoUpdate: false, updateSource: "auto", proxyEnabled: false, proxyAddress: "", allowRemoteClipboardWrite: false,
  recordMcpToolInputs: false, ignoredUpdateVersion: null, mcpEnabled: false, mcpHttpEnabled: false,
  mcpHttpPort: 37653, mcpGroupPermissions: [], shortcuts: DEFAULT_SHORTCUTS,
};

describe("font, size and unrelated settings responses", () => {
  it("keeps the selected font and size when old full settings responses arrive", async () => {
    mocks.get.mockResolvedValue(settings);
    let finishFont!: (settings: AppSettings) => void;
    let finishSize!: (settings: AppSettings) => void;
    mocks.font.mockReturnValue(new Promise<AppSettings>(resolve => { finishFont = resolve; }));
    mocks.size.mockReturnValue(new Promise<AppSettings>(resolve => { finishSize = resolve; }));
    render(<App />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "select Consolas" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "select Consolas" }));
    await waitFor(() => expect(screen.getByTestId("effective-font").textContent).toBe("consolas"));
    fireEvent.click(screen.getByRole("button", { name: "wheel up" }));
    expect(screen.getByTestId("terminal-size").textContent).toBe("14");
    await waitFor(() => expect(mocks.size).toHaveBeenCalledWith(14));
    fireEvent.click(screen.getByRole("button", { name: "other setting response" }));
    await act(async () => {
      finishFont({ ...settings, fontFamily: "consolas" });
      finishSize({ ...settings, terminalFontSize: 14 });
    });
    expect(screen.getByTestId("effective-font").textContent).toBe("consolas");
    expect(screen.getByTestId("terminal-size").textContent).toBe("14");
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--app-font-family")).toContain('"Consolas"');
  });
});
