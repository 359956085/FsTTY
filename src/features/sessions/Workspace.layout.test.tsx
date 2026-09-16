// @vitest-environment jsdom

import { useEffect, useState, type ComponentProps, type RefObject } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
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
}) => <button onClick={onCollapse} ref={collapseButtonRef}>收起右栏</button> }));

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
    shortcuts: DEFAULT_SHORTCUTS, theme: "dark", runtimes: { tab: runtime }, visible: true,
    onCancelTransfer: noop, onDismissTransfer: noop, onCloseTab: noop, onConnected: noop,
    onCredentialSaved: noop, onCreateRemoteDirectory: noop, onCreateSession: noop,
    onDeleteRemoteEntry: noop, onDirectoryChange: noop, onDownload: noop,
    onMoveRemoteEntry: noop, onOpenPath: noop, onRefreshFiles: noop, onRenameRemoteEntry: noop,
    onSelectTab: noop, onTerminalState: noop, onToggleRight: () => setCollapsed(value => !value),
    onUpload: noop, onUploadFiles: noop,
  };
  return <Workspace {...props} />;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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

  it("没有会话时仍能展开右栏，恢复收起状态不抢焦点", () => {
    render(<Preview initiallyCollapsed />);
    const expand = screen.getByRole("button", { name: "nav.expandFiles" });
    expect(document.activeElement).not.toBe(expand);
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "收起右栏" })).not.toBeNull();
  });
});
