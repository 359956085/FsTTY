// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { ShortcutSettingsSection } from "./ShortcutSettingsSection";

const mocks = vi.hoisted(() => ({ updateShortcutSettings: vi.fn() }));

vi.mock("../../shared/api/client", () => ({
  api: { updateShortcutSettings: mocks.updateShortcutSettings },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function appSettings(shortcuts = DEFAULT_SHORTCUTS): AppSettings {
  return {
    allowRemoteClipboardWrite: true,
    autoUpdate: true,
    ignoredUpdateVersion: null,
    language: "zh-CN",
    theme: "system",
    mcpEnabled: false,
    mcpGroupPermissions: [],
    mcpHttpEnabled: false,
    mcpHttpPort: 37_653,
    recordMcpToolInputs: false,
    shortcuts,
    updateProxy: "",
    updateSource: "auto",
  };
}

describe("ShortcutSettingsSection", () => {
  it("显示四项默认快捷键并录入新组合键", async () => {
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
