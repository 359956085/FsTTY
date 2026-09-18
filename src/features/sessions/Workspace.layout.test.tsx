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

function Preview({ withTerminal = false, initiallyCollapsed = false }) {
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
  return <Workspace {...props} />;
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
