// @vitest-environment jsdom

import { useEffect, useState, type ComponentProps, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { TooltipButton } from "../../shared/ui/TooltipButton";
import { createRuntime } from "./useSessionConnections";
import { Workspace } from "./Workspace";

const mocks = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../shared/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("./TerminalPane", () => ({ TerminalPane: () => {
  useEffect(() => { mocks.mount(); return () => { mocks.unmount(); }; }, []);
  return <textarea aria-label="测试终端" defaultValue="保留终端数据" />;
} }));
vi.mock("./DeviceStatusPanel", () => ({ DeviceStatusPanel: () => <div>设备状态</div> }));
vi.mock("./FilesPane", () => ({ FilesPane: ({ onCollapse, collapseButtonRef }: {
  onCollapse: () => void; collapseButtonRef: RefObject<HTMLButtonElement | null>;
}) => <TooltipButton label="收起右栏" onClick={onCollapse} buttonRef={collapseButtonRef} /> }));

function Preview({ withTerminal = false, initiallyCollapsed = false, overrides = {} }: {
  withTerminal?: boolean; initiallyCollapsed?: boolean; overrides?: Partial<ComponentProps<typeof Workspace>>;
}) {
  const [rightCollapsed, setCollapsed] = useState(initiallyCollapsed);
  const noop = vi.fn();
  const runtime = createRuntime();
  const props: ComponentProps<typeof Workspace> = {
    allowRemoteClipboardWrite: false, activeTabId: withTerminal ? "tab" : null,
    activeRuntime: runtime, connectionStates: {}, error: null, loading: false,
    openTabs: withTerminal ? [{ id: "tab", sessionId: "session", autoConnect: true,
      session: { id: "session", name: "测试会话", host: "example.test", port: 22, username: "test",
        group: "", tags: [], auth: { kind: "password" }, credentialState: "stored", loginSavePrompted: true } }] : [],
    rightCollapsed, rightResizeHandle: <div role="separator" aria-label="右栏宽度" />,
    shortcuts: DEFAULT_SHORTCUTS, theme: "dark", terminalColorScheme: "default", runtimes: { tab: runtime }, visible: true,
    onCancelTransfer: noop, onDismissTransfer: noop, onCloseTab: noop, onConnected: noop,
    onCredentialSaved: noop, onCreateRemoteDirectory: noop, onCreateSession: noop,
    onDeleteRemoteEntry: noop, onDeleteRemoteEntries: noop, onDirectoryChange: noop, onDownload: noop, onDownloadFiles: noop,
    onMoveRemoteEntry: noop, onOpenPath: noop, onRefreshFiles: noop, onRenameRemoteEntry: noop,
    onSelectTab: noop, onTerminalState: noop, onToggleRight: () => setCollapsed(value => !value),
    onUpload: noop, onUploadFiles: noop,
  };
  return <Workspace {...props} {...overrides} />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function mockFocusVisible(visible: boolean) {
  vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: HTMLElement, selector) {
    return selector === ":focus-visible" ? visible : Element.prototype.matches.call(this, selector);
  });
}

describe("工作区侧栏布局", () => {
  it.each(["cmd", "powershell", "gitBash"] as const)("%s 的权限形状与各阶段颜色分离，名称和控件不变", (shell) => {
    for (const administrator of [false, true]) {
      for (const state of ["disconnected", "connecting", "connected", "disconnecting", "error"] as const) {
        const runtime = { ...createRuntime(), connectionState: state };
        const view = render(<Preview overrides={{ activeTabId: "tab", activeRuntime: runtime, runtimes: { tab: runtime }, connectionStates: { tab: state },
          openTabs: [{ id: "tab", sessionId: "local", autoConnect: false, runAsAdmin: administrator,
            session: { kind: "local", id: "local", name: "Dev", shell, group: "", tags: [], startingDirectory: "", runAsAdmin: !administrator } }] }} />);
        const icon = view.container.querySelector(".local-tab-status")!;
        expect(icon.getAttribute("data-permission")).toBe(administrator ? "administrator" : "standard");
        expect(icon.classList.contains("local-tab-status-running")).toBe(state === "connected");
        expect(icon.getAttribute("aria-hidden")).toBe("true");
        expect(icon.querySelectorAll("svg")).toHaveLength(1);
        expect(icon.querySelector("g")?.getAttribute("fill")).toBe(administrator ? state === "connected" ? "currentColor" : "none" : undefined);
        expect(view.container.querySelector(".status-dot, .local-admin-badge")).toBeNull();
        expect(screen.getByRole("button", { name: "Dev" }).getAttribute("aria-description")).toContain(administrator ? "local.admin" : "local.standard");
        expect(view.container.querySelectorAll(".session-tab button")).toHaveLength(2);
        view.unmount();
      }
    }
  });
  it.each([false, true])("本地标签权限标记使用实际 elevated=%s，而非配置默认值", (elevated) => {
    const runtime = createRuntime();
    runtime.connection = { connectionId: "local", sessionId: "session", homePath: "C:\\Home", sftpAvailable: false,
      local: { shell: "cmd", label: "CMD", elevated } };
    runtime.connectionState = "connected";
    const { container } = render(<Preview overrides={{ activeTabId: "tab", activeRuntime: runtime, runtimes: { tab: runtime }, connectionStates: { tab: "connected" },
      openTabs: [{ id: "tab", sessionId: "session", autoConnect: false, runAsAdmin: elevated,
        session: { kind: "local", id: "session", name: "CMD", shell: "cmd", group: "", tags: [], startingDirectory: "", runAsAdmin: !elevated } }] }} />);
    expect(container.querySelector(".local-tab-status")!.getAttribute("data-permission")).toBe(elevated ? "administrator" : "standard");
    expect(container.querySelector(".local-admin-badge")).toBeNull();
  });
  it("本地标签隐藏整个右栏，切回 SSH 保留展开状态且终端不重建", () => {
    const view = render(<Preview withTerminal />);
    const terminal = screen.getByRole("textbox", { name: "测试终端" });
    view.rerender(<Preview withTerminal overrides={{ hideRightPanel: true }} />);
    expect(view.container.querySelector(".right-rail")).toBeNull();
    expect(screen.queryByRole("button", { name: "nav.expandFiles" })).toBeNull();
    view.rerender(<Preview withTerminal />);
    expect(view.container.querySelector(".right-rail")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "测试终端" })).toBe(terminal);
    expect(mocks.mount).toHaveBeenCalledOnce(); expect(mocks.unmount).not.toHaveBeenCalled();
  });
  it("收起移除右栏及手柄，焦点往返且终端不重建", () => {
    const { container } = render(<Preview withTerminal />);
    const terminal = screen.getByRole("textbox", { name: "测试终端" });
    fireEvent.click(screen.getByRole("button", { name: "收起右栏" }));
    expect(screen.queryByRole("separator")).toBeNull();
    expect(container.querySelector(".right-rail")).toBeNull();
    expect(container.querySelector(".collapsed-rail")).toBeNull();
    const expand = screen.getByRole("button", { name: "nav.expandFiles" });
    expect(expand.closest(".terminal-panel")).not.toBeNull();
    expect(document.activeElement).toBe(expand);
    fireEvent.click(expand);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "收起右栏" }));
    expect(screen.getByRole("separator")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "测试终端" })).toBe(terminal);
    expect(mocks.mount).toHaveBeenCalledOnce();
    expect(mocks.unmount).not.toHaveBeenCalled();
  });

  it("鼠标收起展开右栏不遗留提示，普通焦点不阻止移出关闭", () => {
    vi.useFakeTimers();
    mockFocusVisible(false);
    render(<Preview withTerminal />);
    const terminal = screen.getByRole("textbox", { name: "测试终端" });
    const collapse = screen.getByRole("button", { name: "收起右栏" });
    fireEvent.pointerDown(collapse, { pointerType: "mouse" });
    fireEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "nav.expandFiles" });
    expect(document.activeElement).toBe(expand);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(expand, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByRole("tooltip").textContent).toBe("nav.expandFiles");
    fireEvent.pointerLeave(expand, { pointerType: "mouse" });
    expect(document.activeElement).toBe(expand);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerDown(expand, { pointerType: "mouse" });
    fireEvent.click(expand);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "收起右栏" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("textbox", { name: "测试终端" })).toBe(terminal);
    expect(mocks.mount).toHaveBeenCalledOnce();
    expect(mocks.unmount).not.toHaveBeenCalled();
  });

  it("键盘收起展开右栏保留焦点与提示，终端不重建", () => {
    mockFocusVisible(true);
    render(<Preview withTerminal />);
    const terminal = screen.getByRole("textbox", { name: "测试终端" });
    const collapse = screen.getByRole("button", { name: "收起右栏" });
    act(() => collapse.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("收起右栏");
    fireEvent.keyDown(collapse, { key: "Enter" });
    fireEvent.click(collapse, { detail: 0 });
    const expand = screen.getByRole("button", { name: "nav.expandFiles" });
    expect(document.activeElement).toBe(expand);
    expect(screen.getByRole("tooltip").textContent).toBe("nav.expandFiles");
    fireEvent.keyDown(expand, { key: " " });
    fireEvent.click(expand, { detail: 0 });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "收起右栏" }));
    expect(screen.getByRole("tooltip").textContent).toBe("收起右栏");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("textbox", { name: "测试终端" })).toBe(terminal);
    expect(mocks.mount).toHaveBeenCalledOnce();
    expect(mocks.unmount).not.toHaveBeenCalled();
  });

  it("没有会话时仍能展开右栏，恢复收起状态不抢焦点", () => {
    render(<Preview initiallyCollapsed />);
    const expand = screen.getByRole("button", { name: "nav.expandFiles" });
    expect(document.activeElement).not.toBe(expand);
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "收起右栏" })).not.toBeNull();
  });
});

describe("标签菜单焦点", () => {
  function tabs(ids: string[]) {
    return ids.map(id => ({ id, sessionId: id, autoConnect: false, session: {
      id, name: id, host: "focus.invalid", port: 22, username: "", group: "", tags: [],
      auth: { kind: "password" as const }, credentialState: "missing" as const, loginSavePrompted: false,
    } }));
  }
  function setup() {
    const close = vi.fn();
    let props: Partial<ComponentProps<typeof Workspace>> = { activeTabId: "B", openTabs: tabs(["A", "B", "C"]), onCloseTab: close };
    const view = render(<Preview overrides={props} />);
    return { close, ...view, update: (next: Partial<typeof props>) => {
      props = { ...props, ...next }; view.rerender(<Preview overrides={props} />);
    } };
  }
  function open(name = "B") {
    const tab = screen.getByRole("button", { name });
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    return tab;
  }
  it("Shift+F10 打开，Esc 与 Tab 恢复标签入口，菜单不重建终端", () => {
    setup();
    const tab = open();
    const terminal = screen.getByRole("textbox", { name: "测试终端" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "sessions.contextCloseCurrent" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(tab);
    fireEvent.keyDown(tab, { key: "ContextMenu" });
    expect(fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(tab);
    expect(screen.getByRole("textbox", { name: "测试终端" })).toBe(terminal);
    expect(mocks.unmount).not.toHaveBeenCalled();
  });
  it.each([false, true])("关闭标签后定位活动标签，无标签=%s 时定位新建入口", (all) => {
    const view = setup(); open();
    fireEvent.click(screen.getByRole("menuitem", { name: all ? "sessions.contextCloseAll" : "sessions.contextCloseCurrent" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "B" }));
    view.update({ activeTabId: all ? null : "C", openTabs: tabs(all ? [] : ["A", "C"]) });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: all ? "sessions.new" : "C" }));
    expect(view.close).toHaveBeenCalledTimes(all ? 3 : 1);
  });
  it("关闭其他标签保留入口，关闭结果迟到时不抢回用户的新焦点", () => {
    const view = setup(); open();
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.contextCloseOthers" }));
    const create = screen.getByRole("button", { name: "sessions.new" });
    act(() => create.focus());
    view.update({ openTabs: tabs(["B"]) });
    expect(document.activeElement).toBe(create);
  });
  it("菜单打开期间标签被移除，Esc 使用当前活动标签作为备用入口", () => {
    const view = setup(); open();
    view.update({ activeTabId: "C", openTabs: tabs(["A", "C"]) });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "C" }));
  });
});
