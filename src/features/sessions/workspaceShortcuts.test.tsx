// @vitest-environment jsdom
import { createRef, StrictMode, useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsPage } from "./SessionsPage";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import type { SessionDialogState } from "./useSessionsPageState";
import type { Session } from "../../shared/api/types";

const fixture = vi.hoisted(() => ({ count: 3, select: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../shared/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("../../shared/api/client", () => ({ api: { detectLocalShells: vi.fn().mockResolvedValue([]) } }));
vi.mock("../lightweight/useLightweightRestore", () => ({ useLightweightRestore: () => ({ error: null }) }));
vi.mock("./SessionList", () => ({ SessionList: () => <input aria-label="Search" /> }));
vi.mock("./FilesPane", () => ({ FilesPane: () => null }));
vi.mock("./DeviceStatusPanel", () => ({ DeviceStatusPanel: () => null }));
vi.mock("./TerminalPane", () => ({ TerminalPane: ({ runtimeId, active }: { runtimeId: string; active: boolean }) => <div className="xterm"><textarea data-active={active} aria-label={`terminal-${runtimeId}`} /></div> }));
vi.mock("./useSessionConnections", async (original) => ({
  ...await original<typeof import("./useSessionConnections")>(),
  useSessionConnections: () => ({ runtimes: {}, pruneRuntimes: vi.fn() }),
}));
vi.mock("./useSessionsPageState", () => ({ useSessionsPageState: useFixture }));
const session: Session = { id: "saved", name: "Saved", host: "example.test", username: "user", port: 22, group: "Servers", tags: [], auth: { kind: "password" }, credentialState: "stored", loginSavePrompted: true };
function useFixture() {
  const [activeTabId, setActiveTabId] = useState("tab-0");
  const [dialogState, setDialogState] = useState<SessionDialogState>(null);
  return {
    sessionsReady: true, loading: false, error: null, activeTabId, dialogState, setDialogState,
    openSessionTabs: Array.from({ length: fixture.count }, (_, i) => ({ id: `tab-${i}`, sessionId: session.id, session, autoConnect: false })),
    groups: [{ name: session.group, sessions: [session] }], sessions: [session],
    selectTab: (id: string) => { fixture.select(id); setActiveTabId(id); },
  };
}
const props: ComponentProps<typeof SessionsPage> = {
  paneLayout: { rootRef: createRef(), layout: { leftWidth: 260, rightWidth: 460, leftCollapsed: false, rightCollapsed: false }, adjustResize: vi.fn(), beginResize: vi.fn(), toggleLeftCollapsed: vi.fn(), toggleRightCollapsed: vi.fn() },
  allowRemoteClipboardWrite: true, shortcuts: DEFAULT_SHORTCUTS, theme: "dark", terminalColorScheme: "default", visible: true,
};
beforeEach(() => { fixture.count = 3; fixture.select.mockClear(); });
afterEach(cleanup);
const key = (target: Element, backwards = false) => fireEvent.keyDown(target, { key: "Tab", code: "Tab", ctrlKey: true, shiftKey: backwards });

describe("工作区统一快捷键", () => {
  it("按显示顺序双向循环，消费终端按键且 StrictMode 不重复执行", () => {
    render(<StrictMode><SessionsPage {...props} /></StrictMode>);
    const terminal = screen.getByLabelText("terminal-tab-0");
    const shell = vi.fn(); terminal.addEventListener("keydown", shell);
    key(terminal); expect(fixture.select).toHaveBeenLastCalledWith("tab-1"); expect(shell).not.toHaveBeenCalled();
    key(screen.getByLabelText("terminal-tab-1")); expect(fixture.select).toHaveBeenLastCalledWith("tab-2");
    key(screen.getByLabelText("terminal-tab-2")); expect(fixture.select).toHaveBeenLastCalledWith("tab-0");
    key(terminal, true); expect(fixture.select).toHaveBeenLastCalledWith("tab-2"); expect(fixture.select).toHaveBeenCalledTimes(4);
  });
  it.each([0, 1])("%i 个标签时不改变状态", (count) => {
    fixture.count = count; render(<SessionsPage {...props} />);
    key(screen.getByRole("button", { name: "sessions.new" })); expect(fixture.select).not.toHaveBeenCalled();
  });
  it("新建取消返回终端原焦点，重复键和弹窗中的快捷键被隔离", () => {
    render(<SessionsPage {...props} />); const terminal = screen.getByLabelText("terminal-tab-0"); terminal.focus();
    fireEvent.keyDown(terminal, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true, repeat: true }); expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(terminal, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    const ssh = screen.getByRole("button", { name: "SSH" }); expect(document.activeElement).toBe(ssh);
    key(ssh); expect(fixture.select).not.toHaveBeenCalled();
    fireEvent.keyDown(ssh, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(terminal);
  });
  it("遵守可见性、输入法、文本输入、菜单及已消费事件", () => {
    const view = render(<SessionsPage {...props} />); const terminal = screen.getByLabelText("terminal-tab-0");
    key(screen.getByLabelText("Search"));
    fireEvent.keyDown(terminal, { key: "Tab", code: "Tab", ctrlKey: true, isComposing: true });
    const event = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", ctrlKey: true, bubbles: true, cancelable: true }); event.preventDefault(); fireEvent(terminal, event);
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu); key(terminal); menu.remove();
    view.rerender(<SessionsPage {...props} visible={false} />); key(terminal);
    expect(fixture.select).not.toHaveBeenCalled();
  });
  it("自定义和未设置绑定生效，卸载后无残留事件处理", () => {
    const { unmount } = render(<SessionsPage {...props} shortcuts={{ ...DEFAULT_SHORTCUTS, nextTab: { code: "KeyJ", ctrl: true, alt: true, shift: false }, previousTab: null }} />);
    const terminal = screen.getByLabelText("terminal-tab-0"); key(terminal); key(terminal, true); expect(fixture.select).not.toHaveBeenCalled();
    fireEvent.keyDown(terminal, { key: "J", code: "KeyJ", ctrlKey: true, altKey: true }); expect(fixture.select).toHaveBeenCalledOnce();
    unmount(); key(document.body); expect(fixture.select).toHaveBeenCalledOnce();
  });
});
