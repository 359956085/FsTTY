// @vitest-environment jsdom
import { StrictMode, use, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { AboutSettingsPanel } from "./AboutSettingsPanel";
import type { AppUpdaterController } from "./useAppUpdater";

const loading = vi.hoisted(() => ({ pending: null as Promise<void> | null, language: "zh-CN" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string) => key, i18n: { language: loading.language, resolvedLanguage: loading.language },
}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("./UpdateHistoryDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./UpdateHistoryDialog")>();
  return { UpdateHistoryDialog: (props: ComponentProps<typeof actual.UpdateHistoryDialog>) => {
    if (loading.pending) use(loading.pending);
    return <actual.UpdateHistoryDialog {...props} />;
  } };
});

const props: ComponentProps<typeof AboutSettingsPanel> = {
  error: null, onAutoUpdateChange: vi.fn(), onCheckUpdates: vi.fn(), onUpdateSourceChange: vi.fn(),
  savingUpdateSettings: false, status: null,
  settings: {
    language: "zh-CN", theme: "system", terminalColorScheme: "default", autoUpdate: true, updateSource: "auto", proxyAddress: "", proxyEnabled: false,
    allowRemoteClipboardWrite: true, recordMcpToolInputs: false, ignoredUpdateVersion: null,
    mcpEnabled: false, mcpHttpEnabled: false, mcpHttpPort: 37653, mcpGroupPermissions: [], shortcuts: DEFAULT_SHORTCUTS,
  },
  updater: { busy: false, currentVersion: "2.0.0", phase: "idle" } as AppUpdaterController,
};
function deferContent() {
  let finish!: () => void;
  loading.pending = new Promise<void>((resolve) => { finish = resolve; });
  return () => { loading.pending = null; finish(); };
}
async function openHistory() {
  const trigger = screen.getByRole("button", { name: "settings.viewUpdateHistory" });
  trigger.focus();
  await act(async () => { fireEvent.click(trigger); });
  return trigger;
}
afterEach(() => { cleanup(); loading.pending = null; loading.language = "zh-CN"; });

describe("更新日志完整焦点生命周期", () => {
  it("首次延迟加载到正文期间焦点不返回背景，StrictMode 下仍可关闭和再次打开", async () => {
    const finish = deferContent();
    render(<StrictMode><AboutSettingsPanel {...props} /></StrictMode>);
    const trigger = await openHistory();
    expect(screen.getByRole("status").textContent).toBe("common.loading");
    const pendingClose = screen.getByRole("button", { name: "sessions.close" });
    expect(document.activeElement).toBe(pendingClose);
    fireEvent.keyDown(pendingClose, { key: "Tab" });
    expect(document.activeElement).toBe(pendingClose);
    const restore = vi.spyOn(trigger, "focus");
    await act(async () => finish());
    await screen.findByRole("heading", { name: "v2.0.0" });
    expect(restore).not.toHaveBeenCalled();
    const close = screen.getAllByRole("button", { name: "sessions.close" })[0];
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(restore).toHaveBeenCalledOnce();
    await openHistory();
    expect(await screen.findByRole("heading", { name: "v2.0.0" })).toBeTruthy();
  });

  it.each(["Escape", "button", "backdrop"])("加载期间 %s 取消后，晚到的内容不重开弹窗", async (method) => {
    const finish = deferContent();
    render(<AboutSettingsPanel {...props} />);
    const trigger = await openHistory();
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      if (method === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (method === "button") fireEvent.click(within(dialog).getByRole("button", { name: "sessions.close" }));
      else expect(fireEvent.mouseDown(dialog.parentElement!)).toBe(false);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    const restore = vi.spyOn(trigger, "focus");
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(restore).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it.each(["top", "footer", "Escape", "backdrop"])("正文 Tab 双向循环，%s 关闭恢复入口", async (method) => {
    const { unmount } = render(<AboutSettingsPanel {...props} />);
    const trigger = await openHistory();
    await screen.findByRole("heading", { name: "v2.0.0" });
    const dialog = screen.getByRole("dialog");
    const [top, footer] = within(dialog).getAllByRole("button", { name: "sessions.close" });
    expect(document.activeElement).toBe(top);
    const content = within(dialog).getByRole("region", { name: "settings.updateHistory" });
    expect(content.tabIndex).toBe(0);
    content.focus();
    const nextTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    content.dispatchEvent(nextTab);
    expect(nextTab.defaultPrevented).toBe(false);
    top.focus();
    fireEvent.keyDown(top, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(footer);
    fireEvent.keyDown(footer, { key: "Tab" });
    expect(document.activeElement).toBe(top);
    fireEvent.mouseDown(screen.getByRole("heading", { name: "v2.0.0" }));
    expect(screen.getByRole("dialog")).toBe(dialog);
    if (method === "top") fireEvent.click(top);
    else if (method === "footer") fireEvent.click(footer);
    else if (method === "Escape") fireEvent.keyDown(top, { key: "Escape" });
    // Cancelling mousedown prevents the browser from focusing the removed
    // backdrop after the close handler has restored focus to the entry button.
    else expect(fireEvent.mouseDown(dialog.parentElement!)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("语言及父组件更新保持当前焦点，入口随页面卸载时不残留聚焦", async () => {
    const { rerender, unmount } = render(<AboutSettingsPanel {...props} />);
    const trigger = await openHistory();
    await screen.findByRole("heading", { name: "v2.0.0" });
    const footer = screen.getAllByRole("button", { name: "sessions.close" })[1];
    footer.focus();
    loading.language = "en-US";
    rerender(<AboutSettingsPanel {...props} status="changed" />);
    expect(document.activeElement).toBe(footer);
    unmount();
    const restore = vi.spyOn(trigger, "focus");
    await act(async () => Promise.resolve());
    expect(restore).not.toHaveBeenCalled();
  });
});
