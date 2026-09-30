// @vitest-environment jsdom

import { createRef, useEffect, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import type { FilesPane } from "./FilesPane";
import { SessionsPage } from "./SessionsPage";
import { createRuntime } from "./useSessionConnections";

const mocks = vi.hoisted(() => ({
  connections: vi.fn<(options: { devicePollingRuntimeId: string | null; errorFallback: string }) => unknown>(),
  sessions: vi.fn(),
  files: vi.fn<(props: ComponentProps<typeof FilesPane>) => void>(),
  terminalMount: vi.fn<(id: string) => void>(),
  terminalUnmount: vi.fn<(id: string) => void>(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../shared/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("../lightweight/useLightweightRestore", () => ({
  useLightweightRestore: () => ({ error: null }),
}));
vi.mock("./useSessionConnections", async (importOriginal) => ({
  ...await importOriginal<typeof import("./useSessionConnections")>(),
  useSessionConnections: mocks.connections,
}));
vi.mock("./useSessionsPageState", () => ({ useSessionsPageState: mocks.sessions }));
vi.mock("./SessionList", () => ({ SessionList: () => <div>会话列表</div> }));
vi.mock("./DeviceStatusPanel", () => ({ DeviceStatusPanel: () => <div>设备状态</div> }));
vi.mock("./TerminalPane", () => ({ TerminalPane: ({ runtimeId }: { runtimeId: string }) => {
  useEffect(() => {
    mocks.terminalMount(runtimeId);
    return () => mocks.terminalUnmount(runtimeId);
  }, [runtimeId]);
  return <textarea aria-label={`终端 ${runtimeId}`} defaultValue="保留输入" />;
} }));
vi.mock("./FilesPane", () => ({ FilesPane: (props: ComponentProps<typeof FilesPane>) => {
  mocks.files(props);
  return <div>
    <button onClick={props.onUpload}>上传</button>
    <button onClick={() => void props.onRenameEntry("/file", "renamed")}>重命名</button>
    <button onClick={() => void props.onDeleteEntries(["/file"])}>删除</button>
  </div>;
} }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function fixture() {
  const session = {
    id: "server", name: "服务器", host: "example.test", port: 22, username: "test",
    group: "", tags: [], auth: { kind: "password" }, credentialState: "stored",
    loginSavePrompted: true,
  };
  const sessions = {
    sessionsReady: true, loading: false, error: null, groups: [], sessions: [session],
    activeTabId: "a", dialogState: null, setDialogState: vi.fn(),
    refreshSessions: vi.fn(), selectTab: vi.fn(),
    openSessionTabs: ["a", "b"].map((id) => ({ id, sessionId: session.id, session, autoConnect: true })),
  };
  const runtime = (id: string) => ({
    ...createRuntime(), connectionState: "connected" as const,
    connection: { connectionId: `connection-${id}`, sessionId: session.id, homePath: "/", sftpAvailable: true },
  });
  const connections = {
    runtimes: { a: runtime("a"), b: runtime("b") },
    pruneRuntimes: vi.fn(), cancelTransfer: vi.fn(), dismissTransfer: vi.fn(),
    handleConnected: vi.fn(), handleTerminalDirectory: vi.fn(), handleTerminalState: vi.fn(),
    createRemoteDirectory: vi.fn(), deleteRemoteEntry: vi.fn(), deleteRemoteEntries: vi.fn(),
    downloadFile: vi.fn(), downloadFiles: vi.fn(), moveRemoteEntry: vi.fn(),
    openPath: vi.fn(), refreshFiles: vi.fn(), renameRemoteEntry: vi.fn(),
    uploadFile: vi.fn(), uploadFiles: vi.fn(),
  };
  mocks.sessions.mockImplementation(() => sessions);
  mocks.connections.mockImplementation(() => connections);
  const props: ComponentProps<typeof SessionsPage> = {
    paneLayout: {
      rootRef: createRef(),
      layout: { leftWidth: 260, rightWidth: 460, leftCollapsed: false, rightCollapsed: false },
      adjustResize: vi.fn(), beginResize: vi.fn(), toggleLeftCollapsed: vi.fn(), toggleRightCollapsed: vi.fn(),
    },
    allowRemoteClipboardWrite: true, shortcuts: DEFAULT_SHORTCUTS,
    theme: "dark", terminalColorScheme: "default", visible: true,
  };
  return { connections, props, sessions };
}

describe("会话页性能边界", () => {
  it("设备更新经过真实父组件时不重渲染文件面板，文件和进度变化仍更新", () => {
    const { connections, props } = fixture();
    const { rerender } = render(<SessionsPage {...props} />);
    expect(mocks.files).toHaveBeenCalledTimes(1);
    connections.runtimes = {
      ...connections.runtimes,
      a: { ...connections.runtimes.a, deviceWindowEndMs: 15_000 },
      b: { ...connections.runtimes.b, deviceWindowEndMs: 20_000 },
    };
    rerender(<SessionsPage {...props} />);
    expect(mocks.files).toHaveBeenCalledTimes(1);
    connections.runtimes.a = {
      ...connections.runtimes.a, currentPath: "/tmp", filesLoading: true,
    };
    rerender(<SessionsPage {...props} />);
    expect(mocks.files).toHaveBeenCalledTimes(2);
    expect(mocks.files.mock.lastCall?.[0].currentPath).toBe("/tmp");
    expect(mocks.files.mock.lastCall?.[0].loading).toBe(true);
    connections.runtimes.a = {
      ...connections.runtimes.a,
      transfer: { id: "transfer", direction: "upload", fileName: "file", transferredBytes: 50,
        totalBytes: 100, speedBytesPerSecond: 5, speedUpdatedAtMs: 0, state: "running" },
    };
    rerender(<SessionsPage {...props} />);
    expect(mocks.files).toHaveBeenCalledTimes(3);
    expect(mocks.files.mock.lastCall?.[0].transfer?.transferredBytes).toBe(50);
    expect(mocks.terminalUnmount).not.toHaveBeenCalled();
  });

  it("标签切换和操作函数更新均使用当前回调", async () => {
    const { connections, props, sessions } = fixture();
    const { rerender } = render(<SessionsPage {...props} />);
    fireEvent.click(screen.getByText("上传"));
    expect(connections.uploadFile).toHaveBeenLastCalledWith("a");
    sessions.activeTabId = "b";
    rerender(<SessionsPage {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByText("上传"));
      fireEvent.click(screen.getByText("重命名"));
      fireEvent.click(screen.getByText("删除"));
    });
    expect(connections.uploadFile).toHaveBeenLastCalledWith("b");
    expect(connections.renameRemoteEntry).toHaveBeenLastCalledWith("b", "/file", "renamed");
    expect(connections.deleteRemoteEntries).toHaveBeenLastCalledWith("b", ["/file"]);
    const previousUpload = connections.uploadFile;
    connections.uploadFile = vi.fn();
    rerender(<SessionsPage {...props} />);
    fireEvent.click(screen.getByText("上传"));
    expect(connections.uploadFile).toHaveBeenCalledWith("b");
    expect(previousUpload).toHaveBeenCalledTimes(2);
    expect(mocks.terminalUnmount).not.toHaveBeenCalled();
  });

  it("设置页和收起右栏停止观察设备但不重建终端", () => {
    const { props } = fixture();
    const { rerender } = render(<SessionsPage {...props} />);
    const terminal = screen.getByRole("textbox", { name: "终端 a" });
    expect(mocks.connections.mock.lastCall?.[0].devicePollingRuntimeId).toBe("a");
    rerender(<SessionsPage {...props} visible={false} />);
    expect(mocks.connections.mock.lastCall?.[0].devicePollingRuntimeId).toBeNull();
    rerender(<SessionsPage {...props} paneLayout={{ ...props.paneLayout,
      layout: { ...props.paneLayout.layout, rightCollapsed: true },
    }} />);
    expect(mocks.connections.mock.lastCall?.[0].devicePollingRuntimeId).toBeNull();
    rerender(<SessionsPage {...props} />);
    expect(mocks.connections.mock.lastCall?.[0].devicePollingRuntimeId).toBe("a");
    expect(screen.getByRole("textbox", { name: "终端 a" })).toBe(terminal);
    expect(mocks.terminalMount).toHaveBeenCalledTimes(1);
    expect(mocks.terminalUnmount).not.toHaveBeenCalled();
  });
});
