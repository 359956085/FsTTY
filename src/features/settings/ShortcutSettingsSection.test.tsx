// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { ShortcutSettingsSection } from "./ShortcutSettingsSection";

const mocks = vi.hoisted(() => ({ updateShortcutSettings: vi.fn() }));

vi.mock("../../shared/api/client", () => ({
  api: { updateShortcutSettings: mocks.updateShortcutSettings },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { action: string }) =>
    key === "settings.shortcutClear" ? `${key} ${options?.action}` : key }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function appSettings(shortcuts = DEFAULT_SHORTCUTS): AppSettings {
  return {
    allowRemoteClipboardWrite: true,
    autoUpdate: true,
    ignoredUpdateVersion: null,
    language: "zh-CN",
    theme: "system",
    terminalColorScheme: "default",
    mcpEnabled: false,
    mcpGroupPermissions: [],
    mcpHttpEnabled: false,
    mcpHttpPort: 37_653,
    recordMcpToolInputs: false,
    shortcuts,
    proxyAddress: "",
    proxyEnabled: false,
    updateSource: "auto",
  };
}

describe("ShortcutSettingsSection", () => {
  it.each([
    ["newSession", "settings.shortcutNewSession"],
    ["nextTab", "settings.shortcutNextTab"],
    ["previousTab", "settings.shortcutPreviousTab"],
  ] as const)("%s 的图标清除按钮保留操作名称、去重及恢复默认", async (action, label) => {
    let resolve!: (value: AppSettings) => void;
    mocks.updateShortcutSettings.mockReturnValueOnce(new Promise<AppSettings>((done) => { resolve = done; }));
    const onChange = vi.fn();
    const view = render(<ShortcutSettingsSection onChange={onChange} settings={DEFAULT_SHORTCUTS} />);
    const clear = screen.getByRole("button", { name: `settings.shortcutClear ${label}` }) as HTMLButtonElement;
    expect(clear.textContent).toBe("");
    expect(clear.querySelector('svg[aria-hidden="true"]')?.getAttribute("width")).toBe("14");
    fireEvent.click(clear);
    fireEvent.click(clear);
    expect(clear.disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: /^settings.shortcutClear / }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(mocks.updateShortcutSettings).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SHORTCUTS, [action]: null });
    const cleared = { ...DEFAULT_SHORTCUTS, [action]: null };
    await act(async () => { resolve(appSettings(cleared)); });
    expect(onChange).toHaveBeenCalledWith(appSettings(cleared));
    view.rerender(<ShortcutSettingsSection onChange={onChange} settings={cleared} />);
    expect(clear.disabled).toBe(true);
    const row = clear.closest(".settings-shortcut-row")!;
    expect(row.querySelector(".settings-shortcut-key")?.textContent).toBe("settings.shortcutUnbound");
    mocks.updateShortcutSettings.mockResolvedValueOnce(appSettings());
    fireEvent.click(row.querySelector('button[title="settings.shortcutRestore"]')!);
    await waitFor(() => expect(mocks.updateShortcutSettings).toHaveBeenLastCalledWith(DEFAULT_SHORTCUTS));
  });

  it("清除保存失败保留绑定和按钮焦点，允许重试", async () => {
    mocks.updateShortcutSettings.mockRejectedValueOnce(new Error("保存失败"));
    const onChange = vi.fn();
    render(<ShortcutSettingsSection onChange={onChange} settings={DEFAULT_SHORTCUTS} />);
    const clear = screen.getByRole("button", { name: "settings.shortcutClear settings.shortcutNewSession" }) as HTMLButtonElement;
    clear.focus();
    fireEvent.click(clear);
    expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
    expect(document.activeElement).toBe(clear);
    expect(clear.disabled).toBe(false);
    expect(clear.closest(".settings-shortcut-row")?.querySelector(".settings-shortcut-key")?.textContent).toBe("Ctrl+Shift+T");
    expect(onChange).not.toHaveBeenCalled();
    mocks.updateShortcutSettings.mockResolvedValueOnce(appSettings({ ...DEFAULT_SHORTCUTS, newSession: null }));
    fireEvent.click(clear);
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  });

  it("键盘焦点显示动作提示，StrictMode 卸载清理延迟提示", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: HTMLElement, selector) {
      return selector === ":focus-visible" || Element.prototype.matches.call(this, selector);
    });
    const view = render(<StrictMode><ShortcutSettingsSection onChange={vi.fn()} settings={DEFAULT_SHORTCUTS} /></StrictMode>);
    const clear = screen.getByRole("button", { name: "settings.shortcutClear settings.shortcutNextTab" });
    void act(() => clear.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("settings.shortcutClearHint");
    fireEvent.keyDown(clear, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(clear, { pointerType: "mouse" });
    view.unmount();
    void act(() => vi.runAllTimers());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("工作区绑定可清除和录制 Tab，组合输入不更改绑定", async () => {
    mocks.updateShortcutSettings.mockResolvedValue(appSettings());
    const { rerender } = render(<ShortcutSettingsSection onChange={vi.fn()} settings={DEFAULT_SHORTCUTS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^settings.shortcutClear / })[0]);
    await waitFor(() => expect(mocks.updateShortcutSettings).toHaveBeenCalledWith({ ...DEFAULT_SHORTCUTS, newSession: null }));
    rerender(<ShortcutSettingsSection onChange={vi.fn()} settings={{ ...DEFAULT_SHORTCUTS, newSession: null }} />);
    await waitFor(() => expect((screen.getAllByRole("button", { name: "settings.shortcutEdit" })[4] as HTMLButtonElement).disabled).toBe(false));
    const edit = screen.getAllByRole("button", { name: "settings.shortcutEdit" })[4];
    fireEvent.click(edit); fireEvent.keyDown(edit, { key: "Tab", code: "Tab", altKey: true, isComposing: true });
    expect(mocks.updateShortcutSettings).toHaveBeenCalledOnce();
    fireEvent.keyDown(edit, { key: "Tab", code: "Tab", altKey: true });
    await waitFor(() => expect(mocks.updateShortcutSettings).toHaveBeenLastCalledWith({ ...DEFAULT_SHORTCUTS, newSession: { code: "Tab", ctrl: false, alt: true, shift: false } }));
  });
  it("显示默认快捷键并录入新组合键", async () => {
    const nextShortcuts = {
      ...DEFAULT_SHORTCUTS,
      commandHistory: { code: "KeyJ", ctrl: true, alt: false, shift: true },
    };
    mocks.updateShortcutSettings.mockResolvedValue(appSettings(nextShortcuts));
    const onChange = vi.fn();
    render(
      <ShortcutSettingsSection onChange={onChange} settings={DEFAULT_SHORTCUTS} />,
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toContain(
      "Ctrl+Shift+H",
    );
    const history = screen.getAllByRole("button", {
      name: "settings.shortcutEdit",
    })[2];
    fireEvent.click(history);
    fireEvent.keyDown(history, {
      altKey: false,
      code: "KeyJ",
      ctrlKey: true,
      key: "J",
      shiftKey: true,
    });

    await waitFor(() =>
      expect(mocks.updateShortcutSettings).toHaveBeenCalledWith(nextShortcuts),
    );
    expect(onChange).toHaveBeenCalledWith(appSettings(nextShortcuts));
  });

  it("冲突时不保存并允许 Escape 取消", () => {
    render(
      <ShortcutSettingsSection onChange={vi.fn()} settings={DEFAULT_SHORTCUTS} />,
    );
    const buttons = screen.getAllByRole("button", { name: "settings.shortcutEdit" });
    const history = buttons[2];
    fireEvent.click(history);
    fireEvent.keyDown(history, {
      code: "KeyC",
      ctrlKey: true,
      key: "c",
    });
    expect(screen.getByRole("alert").textContent).toBe("settings.shortcutConflict");
    expect(mocks.updateShortcutSettings).not.toHaveBeenCalled();

    fireEvent.keyDown(history, { code: "Escape", key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("保存失败保留原值，并支持全部恢复默认", async () => {
    const custom = {
      ...DEFAULT_SHORTCUTS,
      commandHistory: { code: "KeyJ", ctrl: true, alt: false, shift: true },
    };
    mocks.updateShortcutSettings.mockRejectedValueOnce(new Error("保存失败"));
    const { rerender } = render(
      <ShortcutSettingsSection onChange={vi.fn()} settings={DEFAULT_SHORTCUTS} />,
    );
    const history = screen.getAllByRole("button", { name: "settings.shortcutEdit" })[2];
    fireEvent.click(history);
    fireEvent.keyDown(history, {
      code: "KeyJ",
      ctrlKey: true,
      key: "J",
      shiftKey: true,
    });
    expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
    expect(history.textContent).toBe("Ctrl+Shift+H");

    mocks.updateShortcutSettings.mockResolvedValueOnce(appSettings(DEFAULT_SHORTCUTS));
    rerender(<ShortcutSettingsSection onChange={vi.fn()} settings={custom} />);
    fireEvent.click(screen.getByRole("button", { name: "settings.shortcutRestoreAll" }));
    await waitFor(() =>
      expect(mocks.updateShortcutSettings).toHaveBeenLastCalledWith(DEFAULT_SHORTCUTS),
    );
  });

  it("卸载后不应用保存结果", async () => {
    let resolve!: (value: AppSettings) => void;
    mocks.updateShortcutSettings.mockReturnValue(
      new Promise<AppSettings>((next) => { resolve = next; }),
    );
    const onChange = vi.fn();
    const { unmount } = render(
      <ShortcutSettingsSection onChange={onChange} settings={DEFAULT_SHORTCUTS} />,
    );
    const history = screen.getAllByRole("button", { name: "settings.shortcutEdit" })[2];
    fireEvent.click(history);
    fireEvent.keyDown(history, {
      code: "KeyJ",
      ctrlKey: true,
      key: "J",
      shiftKey: true,
    });

    unmount();
    resolve(appSettings());
    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();
  });
});
