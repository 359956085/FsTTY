// @vitest-environment jsdom

import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, ShortcutSettings } from "../../shared/api/types";
import { TerminalPane } from "./TerminalPane";

const apiMocks = vi.hoisted(() => ({
  connectSession: vi.fn(),
  disconnectSession: vi.fn(),
  writeTerminal: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  focus: vi.fn(),
  getTheme: vi.fn((theme: string) => ({ name: theme })),
  install: vi.fn(),
  options: { theme: undefined as unknown },
  oscHandlers: new Map<number, (data: string) => boolean>(),
  registerOscHandler: vi.fn(
    (identifier: number, handler: (data: string) => boolean) => {
      runtimeMocks.oscHandlers.set(identifier, handler);
      return { dispose: vi.fn() };
    },
  ),
  reset: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../shared/api/client", () => ({ api: apiMocks }));

vi.mock("./CommandHistoryPopover", () => ({
  CommandHistoryPopover: ({ onTriggerClose }: { onTriggerClose?: () => void }) => (
    <button onClick={onTriggerClose} type="button">
      sessions.commandHistory
    </button>
  ),
}));

vi.mock("./terminalRuntime", () => ({
  getTerminalTheme: runtimeMocks.getTheme,
  installTerminalRuntime: runtimeMocks.install,
}));

const session: Session = {
  auth: { kind: "password" },
  credentialState: "stored",
  group: "",
  host: "127.0.0.1",
  id: "session-1",
  loginSavePrompted: true,
  name: "测试会话",
  port: 22,
  tags: [],
  username: "root",
};

const shortcut = { alt: false, code: "KeyC", ctrl: true, shift: true };
const shortcuts: ShortcutSettings = {
  commandHistory: shortcut,
  commandHistorySearch: shortcut,
  terminalCopy: shortcut,
  terminalPaste: shortcut,
};

describe("终端面板连接", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.options.theme = undefined;
    apiMocks.connectSession.mockReturnValue(new Promise(() => undefined));
    apiMocks.disconnectSession.mockResolvedValue(undefined);
    apiMocks.writeTerminal.mockResolvedValue(undefined);
    runtimeMocks.oscHandlers.clear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const terminal = {
      attachCustomKeyEventHandler: vi.fn(),
      blur: vi.fn(),
      cols: 80,
      element: null,
      focus: runtimeMocks.focus,
      modes: { mouseTrackingMode: "none" },
      onData: vi.fn(),
      options: runtimeMocks.options,
      parser: { registerOscHandler: runtimeMocks.registerOscHandler },
      reset: runtimeMocks.reset,
      rows: 24,
      textarea: null,
    };
    runtimeMocks.install.mockImplementation(async ({
      isCancelled,
    }: {
      isCancelled: () => boolean;
    }) => {
      await Promise.resolve();
      if (isCancelled()) {
        return null;
      }
      return {
        dispose: runtimeMocks.dispose,
        fitAddon: { fit: vi.fn() },
        terminal,
      };
    });
  });

  it("StrictMode 重放后点击连接只发起一次请求", async () => {
    render(
      <StrictMode>
        <TerminalPane
          active
          allowRemoteClipboardWrite={false}
          autoConnect={false}
          connectionState="disconnected"
          onConnected={vi.fn()}
          onCredentialSaved={vi.fn()}
          onDirectoryChange={vi.fn()}
          onStateChange={vi.fn()}
          runtimeId="runtime-1"
          session={session}
          shortcuts={shortcuts}
          theme="dark"
          visible
        />
      </StrictMode>,
    );

    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledTimes(2));
    const connectButton = screen.getByRole("button", { name: "sessions.connect" });
    fireEvent.click(connectButton);
    fireEvent.click(connectButton);

    await waitFor(() => expect(apiMocks.connectSession).toHaveBeenCalledTimes(1));
    expect(runtimeMocks.reset).toHaveBeenCalledTimes(1);
  });

  it("切换主题时更新现有终端而不重新安装", async () => {
    const commonProps = {
      active: true,
      allowRemoteClipboardWrite: false,
      autoConnect: false,
      connectionState: "disconnected" as const,
      onConnected: vi.fn(),
      onCredentialSaved: vi.fn(),
      onDirectoryChange: vi.fn(),
      onStateChange: vi.fn(),
      runtimeId: "runtime-theme",
      session,
      shortcuts,
      visible: true,
    };
    const { rerender } = render(<TerminalPane {...commonProps} theme="dark" />);
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "dark" }));

    rerender(<TerminalPane {...commonProps} theme="light" />);
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "light" }));
    expect(runtimeMocks.install).toHaveBeenCalledTimes(1);
  });

  it("点击历史按钮关闭弹窗后恢复终端焦点", async () => {
    const getClientRects = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    render(
      <TerminalPane
        active
        allowRemoteClipboardWrite={false}
        autoConnect={false}
        connectionState="connected"
        onConnected={vi.fn()}
        onCredentialSaved={vi.fn()}
        onDirectoryChange={vi.fn()}
        onStateChange={vi.fn()}
        runtimeId="runtime-history-focus"
        session={session}
        shortcuts={shortcuts}
        theme="dark"
        visible
      />,
    );
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    const trigger = screen.getByRole("button", { name: /sessions.commandHistory/ });
    runtimeMocks.focus.mockClear();

    fireEvent.click(trigger);
    expect(runtimeMocks.focus).toHaveBeenCalledOnce();
    getClientRects.mockRestore();
  });

  it("注册标准和私有协议，Bash 无原生能力时注入一次", async () => {
    const onConnected = vi.fn();
    apiMocks.connectSession.mockResolvedValue({
      kind: "connected",
      connection: {
        connectionId: "connection-1",
        homePath: "/home/root",
        shellName: "bash",
        sessionId: "session-1",
        sftpAvailable: true,
      },
    });
    render(
      <TerminalPane
        active
        allowRemoteClipboardWrite={false}
        autoConnect={false}
        connectionState="disconnected"
        onConnected={onConnected}
        onCredentialSaved={vi.fn()}
        onDirectoryChange={vi.fn()}
        onStateChange={vi.fn()}
        runtimeId="runtime-passive"
        session={session}
        shortcuts={shortcuts}
        theme="dark"
        visible
      />,
    );
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    expect(runtimeMocks.registerOscHandler.mock.calls.map(([identifier]) => identifier)).toEqual([
      7,
      133,
      633,
      777,
    ]);

    fireEvent.click(screen.getByRole("button", { name: "sessions.connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    await waitFor(() => expect(apiMocks.writeTerminal).toHaveBeenCalledOnce());
    expect(apiMocks.writeTerminal.mock.calls[0]?.[0]).toBe("connection-1");
    expect(apiMocks.writeTerminal.mock.calls[0]?.[1]).toContain("fstty-ready");
  });

  it("连接完成前收到原生 OSC 633 能力时不注入", async () => {
    let resolveConnect!: (value: unknown) => void;
    const onConnected = vi.fn();
    apiMocks.connectSession.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );
    render(
      <TerminalPane
        active
        allowRemoteClipboardWrite={false}
        autoConnect={false}
        connectionState="disconnected"
        onConnected={onConnected}
        onCredentialSaved={vi.fn()}
        onDirectoryChange={vi.fn()}
        onStateChange={vi.fn()}
        runtimeId="runtime-native"
        session={session}
        shortcuts={shortcuts}
        theme="dark"
        visible
      />,
    );
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "sessions.connect" }));
    await waitFor(() => expect(apiMocks.connectSession).toHaveBeenCalledOnce());
    runtimeMocks.oscHandlers.get(633)?.("P;HasRichCommandDetection=True");
    resolveConnect({
      kind: "connected",
      connection: {
        connectionId: "connection-native",
        homePath: "/home/root",
        sessionId: "session-1",
        shellName: "bash",
        sftpAvailable: true,
      },
    });
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(apiMocks.writeTerminal).not.toHaveBeenCalled();
  });
});
