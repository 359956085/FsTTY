// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PreservedTerminalAttachment, Session, ShortcutSettings, TerminalEvent, TerminalResumeEvent,
} from "../../shared/api/types";
import { TerminalPane } from "./TerminalPane";
import {
  enterLightweightMode, hasPreservedTerminal, initializeLightweightMode,
} from "../lightweight/lightweightMode";

interface TestChannel<T> { onmessage(event: T): void }

const apiMocks = vi.hoisted(() => ({
  connectSession: vi.fn(),
  disconnectSession: vi.fn(),
  setSessionCredential: vi.fn(),
  trustHostKey: vi.fn(),
  writeTerminal: vi.fn(),
  attachPreservedTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  beginLightweightMode: vi.fn(),
  appendLightweightSnapshotChunk: vi.fn(),
  commitLightweightMode: vi.fn(),
  abortLightweightMode: vi.fn(),
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
  resize: vi.fn(),
  write: vi.fn<(data: string | Uint8Array, callback?: () => void) => void>(),
  writeln: vi.fn(),
  serialize: vi.fn(),
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

function preserveTerminal(): PreservedTerminalAttachment {
  const attachment: PreservedTerminalAttachment = {
    runtimeId: "runtime-preserved",
    connection: {
      connectionId: "connection-preserved", sessionId: session.id,
      homePath: "/home", sftpAvailable: true, shellName: "bash",
    },
    currentPath: "/srv", columns: 120, rows: 40, truncated: false,
    shellIntegrationToken: "0123456789abcdef0123456789abcdef",
  };
  initializeLightweightMode({
    active: true, suppressConfirmation: false, phase: "detached", transferJobs: [],
    terminals: [{
      runtimeId: attachment.runtimeId, connectionId: attachment.connection.connectionId,
      sessionId: session.id, currentPath: attachment.currentPath,
    }],
  });
  return attachment;
}

function renderPreservedTerminal() {
  const onConnected = vi.fn();
  const onStateChange = vi.fn();
  const onDirectoryChange = vi.fn();
  return {
    ...render(<TerminalPane
      active allowRemoteClipboardWrite={false} autoConnect={false}
      connectionState="disconnected" onConnected={onConnected}
      onCredentialSaved={vi.fn()} onDirectoryChange={onDirectoryChange}
      onStateChange={onStateChange} runtimeId="runtime-preserved"
      session={session} shortcuts={shortcuts} theme="dark" visible
    />),
    onConnected, onStateChange, onDirectoryChange,
  };
}

describe("终端面板连接", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    initializeLightweightMode({
      active: false, suppressConfirmation: false, phase: "normal", terminals: [], transferJobs: [],
    });
    runtimeMocks.options.theme = undefined;
    apiMocks.connectSession.mockReturnValue(new Promise(() => undefined));
    apiMocks.disconnectSession.mockResolvedValue(undefined);
    apiMocks.setSessionCredential.mockResolvedValue(undefined);
    apiMocks.trustHostKey.mockResolvedValue(undefined);
    apiMocks.writeTerminal.mockResolvedValue(undefined);
    apiMocks.attachPreservedTerminal.mockReturnValue(new Promise(() => undefined));
    apiMocks.resizeTerminal.mockResolvedValue(undefined);
    apiMocks.beginLightweightMode.mockResolvedValue({ token: "token" });
    apiMocks.appendLightweightSnapshotChunk.mockResolvedValue(undefined);
    apiMocks.commitLightweightMode.mockResolvedValue(undefined);
    apiMocks.abortLightweightMode.mockResolvedValue(undefined);
    runtimeMocks.write.mockImplementation((_data, callback) => callback?.());
    runtimeMocks.serialize.mockReturnValue("screen");
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
      resize: runtimeMocks.resize,
      write: runtimeMocks.write,
      writeln: runtimeMocks.writeln,
      textarea: null,
    };
    runtimeMocks.resize.mockImplementation((columns: number, rows: number) => {
      terminal.cols = columns;
      terminal.rows = rows;
    });
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
        serializeAddon: { serialize: runtimeMocks.serialize },
        terminal,
      };
    });
  });

  it("保活恢复先使用原尺寸，不注入命令，并在恢复后继续处理断线", async () => {
    const attachment = preserveTerminal();
    let resume!: { onmessage(event: TerminalResumeEvent): void };
    apiMocks.attachPreservedTerminal.mockImplementation(async (_runtimeId: string, channel: TestChannel<TerminalResumeEvent>) => {
      resume = channel;
      channel.onmessage({
        kind: "snapshot", connectionId: attachment.connection.connectionId,
        data: btoa("saved"), chunkIndex: 0, totalChunks: 1, truncated: false,
      });
      channel.onmessage({ kind: "data", connectionId: attachment.connection.connectionId, data: btoa("delta") });
      channel.onmessage({ kind: "ready", connectionId: attachment.connection.connectionId, truncated: false });
      return attachment;
    });
    const { onConnected, onStateChange, onDirectoryChange } = renderPreservedTerminal();
    await waitFor(() => expect(hasPreservedTerminal(attachment.runtimeId)).toBe(false));
    expect(runtimeMocks.resize).toHaveBeenCalledWith(120, 40);
    expect(runtimeMocks.resize.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeMocks.write.mock.invocationCallOrder[0]!,
    );
    expect(runtimeMocks.write.mock.calls.map(([data]) =>
      typeof data === "string" ? data : new TextDecoder().decode(data),
    )).toEqual(["saved", "delta", ""]);
    expect(onConnected).toHaveBeenCalledWith(attachment.runtimeId, attachment.connection);
    expect(apiMocks.writeTerminal).not.toHaveBeenCalled();
    runtimeMocks.oscHandlers.get(777)?.("fstty-cwd:0123456789abcdef0123456789abcdef:/srv/new");
    expect(onDirectoryChange).toHaveBeenCalledWith(attachment.runtimeId, "/srv/new");

    act(() => resume.onmessage({
      kind: "disconnected", connectionId: attachment.connection.connectionId, message: "closed",
    }));
    expect(onStateChange).toHaveBeenLastCalledWith(attachment.runtimeId, "disconnected", "closed");
    apiMocks.connectSession.mockResolvedValueOnce({
      kind: "connected", connection: { ...attachment.connection, connectionId: "new", shellName: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "sessions.connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2));
    const writes = runtimeMocks.write.mock.calls.length;
    act(() => resume.onmessage({
      kind: "data", connectionId: attachment.connection.connectionId, data: btoa("late"),
    }));
    expect(runtimeMocks.write).toHaveBeenCalledTimes(writes);
  });

  it("恢复请求未完成就卸载时忽略迟到快照并清理返回连接", async () => {
    const attachment = preserveTerminal();
    let resolveAttach!: (value: PreservedTerminalAttachment) => void;
    apiMocks.attachPreservedTerminal.mockReturnValueOnce(new Promise((resolve) => { resolveAttach = resolve; }));
    const { unmount, onConnected } = renderPreservedTerminal();
    await waitFor(() => expect(apiMocks.attachPreservedTerminal).toHaveBeenCalledOnce());
    unmount();
    const channel = apiMocks.attachPreservedTerminal.mock.calls[0]?.[1] as TestChannel<TerminalResumeEvent>;
    await act(async () => {
      channel.onmessage({ kind: "snapshot", connectionId: attachment.connection.connectionId,
        chunkIndex: 0, totalChunks: 1, truncated: false, data: btoa("late") });
      resolveAttach(attachment);
    });
    expect(runtimeMocks.write).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(apiMocks.disconnectSession).toHaveBeenCalledWith(attachment.connection.connectionId);
  });

  it("真实终端屏障等待写队列排空，轻量卸载不误断开", async () => {
    const attachment = preserveTerminal();
    initializeLightweightMode({ active: false, suppressConfirmation: false, phase: "normal", terminals: [], transferJobs: [] });
    apiMocks.connectSession.mockResolvedValueOnce({
      kind: "connected", connection: { ...attachment.connection, shellName: null },
    });
    const { unmount, onConnected } = renderPreservedTerminal();
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "sessions.connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    const channel = apiMocks.connectSession.mock.calls[0]?.[3] as TestChannel<TerminalEvent>;
    let drain!: () => void;
    runtimeMocks.write.mockImplementation((_data, callback) => { if (callback) drain = callback; });
    apiMocks.beginLightweightMode.mockImplementationOnce(async () => {
      channel.onmessage({ kind: "data", connectionId: attachment.connection.connectionId, data: btoa("before") });
      channel.onmessage({ kind: "data", connectionId: attachment.connection.connectionId, data: "" });
      return { token: "token" };
    });
    const transition = enterLightweightMode(false);
    await waitFor(() => expect(drain).toBeTypeOf("function"));
    expect(runtimeMocks.serialize).not.toHaveBeenCalled();
    drain();
    await transition;
    expect(runtimeMocks.serialize.mock.calls).toEqual([[{ scrollback: 10_000 }], [{ scrollback: 0 }]]);
    unmount();
    expect(apiMocks.disconnectSession).not.toHaveBeenCalled();
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

  it("主机信任重复点击只提交一次并在完成后重连", async () => {
    let resolveTrust!: () => void;
    apiMocks.connectSession
      .mockResolvedValueOnce({
        kind: "hostKeyRequired",
        challenge: {
          algorithm: "ssh-ed25519",
          challengeId: "challenge-1",
          fingerprint: "SHA256:test",
          host: "127.0.0.1",
          port: 22,
        },
      })
      .mockReturnValueOnce(new Promise(() => undefined));
    apiMocks.trustHostKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveTrust = resolve;
      }),
    );
    render(
      <TerminalPane
        active
        allowRemoteClipboardWrite={false}
        autoConnect={false}
        connectionState="disconnected"
        onConnected={vi.fn()}
        onCredentialSaved={vi.fn()}
        onDirectoryChange={vi.fn()}
        onStateChange={vi.fn()}
        runtimeId="runtime-trust"
        session={session}
        shortcuts={shortcuts}
        theme="dark"
        visible
      />,
    );
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "sessions.connect" }));
    const trustButton = await screen.findByRole("button", {
      name: "sessions.trustAndConnect",
    });
    fireEvent.click(trustButton);
    fireEvent.click(trustButton);

    expect(apiMocks.trustHostKey).toHaveBeenCalledTimes(1);
    resolveTrust();
    await waitFor(() => expect(apiMocks.connectSession).toHaveBeenCalledTimes(2));
  });

  it("关闭主机信任弹窗后忽略晚到结果", async () => {
    let resolveTrust!: () => void;
    apiMocks.connectSession.mockResolvedValueOnce({
      kind: "hostKeyRequired",
      challenge: {
        algorithm: "ssh-ed25519",
        challengeId: "challenge-2",
        fingerprint: "SHA256:test",
        host: "127.0.0.1",
        port: 22,
      },
    });
    apiMocks.trustHostKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveTrust = resolve;
      }),
    );
    render(
      <TerminalPane
        active
        allowRemoteClipboardWrite={false}
        autoConnect={false}
        connectionState="disconnected"
        onConnected={vi.fn()}
        onCredentialSaved={vi.fn()}
        onDirectoryChange={vi.fn()}
        onStateChange={vi.fn()}
        runtimeId="runtime-trust-cancel"
        session={session}
        shortcuts={shortcuts}
        theme="dark"
        visible
      />,
    );
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "sessions.connect" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "sessions.trustAndConnect" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sessions.cancel" }));
    resolveTrust();
    await Promise.resolve();

    expect(apiMocks.connectSession).toHaveBeenCalledTimes(1);
  });
});
