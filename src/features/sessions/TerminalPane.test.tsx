// @vitest-environment jsdom

import { StrictMode, cloneElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PreservedTerminalAttachment, Session, ShortcutSettings, TerminalEvent, TerminalResumeEvent,
} from "../../shared/api/types";
import { TerminalPane } from "./TerminalPane";
import i18n from "../../shared/i18n";
import {
  enterLightweightMode, hasPreservedTerminal, initializeLightweightMode,
} from "../lightweight/lightweightMode";

interface TestChannel<T> { onmessage(event: T): void }
const translationMocks = vi.hoisted(() => ({ language: null as "zh" | "en" | null }));

const apiMocks = vi.hoisted(() => ({
  connectSession: vi.fn(),
  startLocalTerminal: vi.fn(),
  cancelLocalTerminalStart: vi.fn(),
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
  getTheme: vi.fn((theme: string, colorScheme: string) => ({ name: theme, colorScheme })),
  install: vi.fn(),
  options: { theme: undefined as unknown, minimumContrastRatio: 1 },
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

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => translationMocks.language ? i18n.getFixedT(translationMocks.language)(key) : key }),
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
    newSession: { code: "KeyT", ctrl: true, shift: true, alt: false },
    nextTab: { code: "Tab", ctrl: true, shift: false, alt: false },
    previousTab: { code: "Tab", ctrl: true, shift: true, alt: false },
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

function renderPreservedTerminal(overrides: Partial<ComponentProps<typeof TerminalPane>> = {}) {
  const onConnected = vi.fn();
  const onStateChange = vi.fn();
  const onDirectoryChange = vi.fn();
  const pane = <TerminalPane
      active allowRemoteClipboardWrite={false} autoConnect={false}
      connectionState="disconnected" onConnected={onConnected}
      onCredentialSaved={vi.fn()} onDirectoryChange={onDirectoryChange}
      onStateChange={onStateChange} runtimeId="runtime-preserved"
      session={session} shortcuts={shortcuts} theme="dark" visible {...overrides}
    />;
  const view = render(pane);
  return {
    ...view,
    rerenderTerminal: (next: Partial<ComponentProps<typeof TerminalPane>>) => view.rerender(cloneElement(pane, next)),
    onConnected, onStateChange, onDirectoryChange,
  };
}

describe("终端面板连接", () => {
  afterEach(cleanup);

  beforeEach(() => {
    translationMocks.language = null;
    vi.clearAllMocks();
    runtimeMocks.focus.mockReset();
    initializeLightweightMode({
      active: false, suppressConfirmation: false, phase: "normal", terminals: [], transferJobs: [],
    });
    runtimeMocks.options.theme = undefined;
    apiMocks.startLocalTerminal.mockReturnValue(new Promise(() => undefined));
    apiMocks.cancelLocalTerminalStart.mockResolvedValue(undefined);
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
      getSelection: vi.fn(() => ""),
      selectAll: vi.fn(),
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
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "dark", colorScheme: "default" }));

    rerender(<TerminalPane {...commonProps} theme="light" />);
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "light", colorScheme: "default" }));
    rerender(<TerminalPane {...commonProps} theme="light" terminalColorScheme="dracula" />);
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "light", colorScheme: "dracula" }));
    expect(runtimeMocks.options.minimumContrastRatio).toBe(4.5);
    rerender(<TerminalPane {...commonProps} theme="dark" terminalColorScheme="dracula" />);
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "dark", colorScheme: "dracula" }));
    rerender(<TerminalPane {...commonProps} theme="dark" terminalColorScheme="default" />);
    await waitFor(() => expect(runtimeMocks.options.theme).toEqual({ name: "dark", colorScheme: "default" }));
    expect(runtimeMocks.options.minimumContrastRatio).toBe(1);
    expect(runtimeMocks.install).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.dispose).not.toHaveBeenCalled();
    expect(apiMocks.connectSession).not.toHaveBeenCalled();
  });

  it("本地右键菜单聚焦可用项，Esc 返回终端输入，外部点击保留目标焦点", async () => {
    const view = renderPreservedTerminal();
    await act(async () => { await runtimeMocks.install.mock.results[0].value; });
    const body = view.container.querySelector<HTMLElement>(".terminal-body")!;
    const input = document.createElement("textarea");
    body.append(input);
    runtimeMocks.focus.mockImplementation(() => input.focus());
    fireEvent.contextMenu(body, { clientX: 100, clientY: 100 });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "sessions.contextPaste" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(input);
    fireEvent.contextMenu(body);
    const history = screen.getByRole("button", { name: "sessions.commandHistory" });
    fireEvent.mouseDown(history);
    act(() => history.focus());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(history);
    expect(apiMocks.writeTerminal).not.toHaveBeenCalled();
    expect(runtimeMocks.dispose).not.toHaveBeenCalled();
  });

  it("关闭标签返回的入口焦点不会被终端激活覆盖，普通激活仍聚焦终端", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    const activationFocusTarget = { current: target as HTMLElement | null };
    const view = renderPreservedTerminal({ active: false, connectionState: "connected", activationFocusTarget });
    await act(async () => { await runtimeMocks.install.mock.results[0].value; });
    target.focus();
    runtimeMocks.focus.mockClear();
    view.rerenderTerminal({ active: true });
    expect(document.activeElement).toBe(target);
    expect(runtimeMocks.focus).not.toHaveBeenCalled();
    view.rerenderTerminal({ active: false });
    activationFocusTarget.current = null;
    view.rerenderTerminal({ active: true });
    expect(runtimeMocks.focus).toHaveBeenCalledOnce();
    expect(runtimeMocks.dispose).not.toHaveBeenCalled();
    target.remove();
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
  it("本地启动独立于 SSH，收到输出后退出保留输出和重启入口", async () => {
    const local = { kind: "local" as const, id: session.id, name: "CMD", group: "", tags: [], shell: "cmd" as const, startingDirectory: "", runAsAdmin: true };
    const connection = { connectionId: "local-1", sessionId: local.id, homePath: "C:\\Home", sftpAvailable: false, local: { shell: "cmd" as const, elevated: false, label: "CMD" } };
    let events!: TestChannel<TerminalEvent>;
    apiMocks.startLocalTerminal.mockImplementation(async (_id: string, _runtime: string, _cols: number, _rows: number, channel: TestChannel<TerminalEvent>) => { events = channel; return connection; });
    const view = renderPreservedTerminal({ session: local, autoConnect: true, runAsAdmin: false });
    await waitFor(() => expect(view.onConnected).toHaveBeenCalledWith("runtime-preserved", connection));
    expect(apiMocks.connectSession).not.toHaveBeenCalled();
    expect(apiMocks.startLocalTerminal.mock.calls[0][6]).toBe(false);
    expect(screen.queryByRole("button", { name: "sessions.commandHistory" })).toBeNull();
    view.rerenderTerminal({ connectionState: "connected" });
    act(() => events.onmessage({ kind: "data", connectionId: "local-1", data: btoa("output") }));
    expect(new TextDecoder().decode(runtimeMocks.write.mock.calls[runtimeMocks.write.mock.calls.length - 1]![0] as Uint8Array)).toBe("output");
    const writes = apiMocks.writeTerminal.mock.calls.length;
    runtimeMocks.oscHandlers.get(777)?.("fstty-cwd:0123456789abcdef0123456789abcdef:/wrong");
    expect(view.onDirectoryChange).not.toHaveBeenCalled(); expect(apiMocks.writeTerminal).toHaveBeenCalledTimes(writes);
    act(() => events.onmessage({ kind: "disconnected", connectionId: "local-1", exitCode: 7, message: "exited" }));
    view.rerenderTerminal({ connectionState: "disconnected" });
    expect(screen.getByRole("button", { name: "local.restart" })).toBeTruthy();
    expect(runtimeMocks.reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "local.restart" }));
    await waitFor(() => expect(apiMocks.startLocalTerminal).toHaveBeenCalledTimes(2));
    expect(apiMocks.startLocalTerminal.mock.calls[1][6]).toBeUndefined();
    view.unmount();
  });


  it("本地 shell 在启动响应前退出，重试时仍恢复配置默认权限", async () => {
    const local = { kind: "local" as const, id: session.id, name: "CMD", group: "", tags: [], shell: "cmd" as const, startingDirectory: "", runAsAdmin: false };
    const connection = { connectionId: "short-local", sessionId: local.id, homePath: "C:\\Home", sftpAvailable: false, local: { shell: "cmd" as const, elevated: true, label: "CMD" } };
    let events!: TestChannel<TerminalEvent>;
    let finish!: (value: unknown) => void;
    apiMocks.startLocalTerminal.mockImplementationOnce((_id: string, _runtime: string, _cols: number, _rows: number, channel: TestChannel<TerminalEvent>) => {
      events = channel;
      return new Promise((resolve) => { finish = resolve; });
    });
    const view = renderPreservedTerminal({ session: local, autoConnect: true, runAsAdmin: true });
    await waitFor(() => expect(apiMocks.startLocalTerminal).toHaveBeenCalledOnce());
    act(() => events.onmessage({ kind: "disconnected", connectionId: connection.connectionId, exitCode: 0, message: "exited" }));
    await act(async () => finish(connection));
    expect(apiMocks.disconnectSession).toHaveBeenCalledWith(connection.connectionId);
    expect(view.onConnected).not.toHaveBeenCalled();
    view.rerenderTerminal({ connectionState: "disconnected" });
    fireEvent.click(screen.getByRole("button", { name: "local.restart" }));
    await waitFor(() => expect(apiMocks.startLocalTerminal).toHaveBeenCalledTimes(2));
    expect(apiMocks.startLocalTerminal.mock.calls[1][6]).toBeUndefined();
    view.unmount();
  });

  it("取消未完成本地启动后清理迟到结果，不影响下一次尝试", async () => {
    const local = { kind: "local" as const, id: session.id, name: "CMD", group: "", tags: [], shell: "cmd" as const, startingDirectory: "", runAsAdmin: true };
    let resolve!: (value: unknown) => void;
    apiMocks.startLocalTerminal.mockImplementationOnce(() => new Promise((next) => { resolve = next; }));
    const view = renderPreservedTerminal({ session: local, autoConnect: true, runAsAdmin: false });
    await waitFor(() => expect(apiMocks.startLocalTerminal).toHaveBeenCalledOnce());
    const request = apiMocks.startLocalTerminal.mock.calls[0][5] as string;
    view.rerenderTerminal({ connectionState: "connecting" });
    fireEvent.click(screen.getByRole("button", { name: "sessions.cancel" }));
    await waitFor(() => expect(apiMocks.cancelLocalTerminalStart).toHaveBeenCalledWith(request));
    await act(async () => resolve({ connectionId: "late-local", sessionId: local.id, homePath: "C:\\Home", sftpAvailable: false }));
    expect(apiMocks.disconnectSession).toHaveBeenCalledWith("late-local"); expect(view.onConnected).not.toHaveBeenCalled();
    view.rerenderTerminal({ connectionState: "disconnected" });
    fireEvent.click(screen.getByRole("button", { name: "local.start" }));
    await waitFor(() => expect(apiMocks.startLocalTerminal).toHaveBeenCalledTimes(2));
    expect(apiMocks.startLocalTerminal.mock.calls[1][5]).not.toBe(request);
    expect(apiMocks.startLocalTerminal.mock.calls[1][6]).toBe(false);
    view.unmount(); expect(apiMocks.cancelLocalTerminalStart).toHaveBeenCalledTimes(2);
  });

  it("本地编辑或切换可见性不会重建进程，未运行标签聚焦启动入口", async () => {
    const local = { kind: "local" as const, id: session.id, name: "CMD", group: "", tags: [], shell: "cmd" as const, startingDirectory: "", runAsAdmin: false };
    const view = renderPreservedTerminal({ session: local, active: false });
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    view.rerenderTerminal({ active: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "local.start" }));
    view.rerenderTerminal({ session: { ...local, name: "Edited", startingDirectory: "C:\\Next" }, visible: false });
    view.rerenderTerminal({ visible: true });
    expect(apiMocks.startLocalTerminal).not.toHaveBeenCalled(); expect(runtimeMocks.dispose).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    "当前环境无法以普通权限启动终端。请右键会话，选择“以管理员权限打开”。",
    "已取消管理员授权，终端未启动。点击“启动”可重试。",
    "起始目录不存在或无法访问。请编辑会话，选择可用目录，或留空使用用户主目录。",
    "未检测到 Git Bash。安装或修复后，请点击“重新检测”。",
    "本地终端启动超时。请重试；如仍失败，请查看日志。",
    "本地终端安全校验失败，启动已停止。请查看日志。",
  ])("本地启动失败保留标签、权限配置及输出，并允许重试：%s", async (message) => {
    const local = { kind: "local" as const, id: session.id, name: "CMD", group: "", tags: [], shell: "cmd" as const, startingDirectory: "C:\\Draft", runAsAdmin: true };
    apiMocks.startLocalTerminal.mockRejectedValueOnce({ kind: "connection", message });
    const view = renderPreservedTerminal({ session: local, autoConnect: true, runAsAdmin: false });
    await waitFor(() => expect(view.onStateChange).toHaveBeenCalledWith("runtime-preserved", "error", message));
    view.rerenderTerminal({ connectionState: "error" });
    expect(screen.getByText("local.manualStart")).toBeTruthy();
    const start = screen.getByRole("button", { name: "local.start" });
    start.focus();
    view.rerenderTerminal({ connectionState: "error", session: { ...local } });
    expect(document.activeElement).toBe(start);
    expect(runtimeMocks.dispose).not.toHaveBeenCalled();
    expect(runtimeMocks.reset).not.toHaveBeenCalled();
    expect(local.runAsAdmin).toBe(true);
    expect(local.startingDirectory).toBe("C:\\Draft");
    expect(view.onConnected).not.toHaveBeenCalled();
    // Failure must not automatically retry or escalate the request.
    expect(apiMocks.startLocalTerminal).toHaveBeenCalledOnce();
    fireEvent.click(start);
    await waitFor(() => expect(apiMocks.startLocalTerminal).toHaveBeenCalledTimes(2));
    expect(apiMocks.startLocalTerminal.mock.calls[1][6]).toBe(false);
    expect(apiMocks.startLocalTerminal.mock.calls[1][5]).not.toBe(apiMocks.startLocalTerminal.mock.calls[0][5]);
    view.unmount();
  });

  it.each(["zh", "en"] as const)("%s 本地启动状态准确，语言更新不重置焦点", async (language) => {
    translationMocks.language = language;
    const t = i18n.getFixedT(language);
    const local = { kind: "local" as const, id: session.id, name: "CMD", group: "", tags: [], shell: "cmd" as const, startingDirectory: "", runAsAdmin: false };
    const view = renderPreservedTerminal({ session: local });
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledOnce());
    const start = screen.getByRole("button", { name: t("local.start") });
    expect(screen.getByText(t("local.manualStart"))).toBeTruthy();
    start.focus();
    translationMocks.language = language === "zh" ? "en" : "zh";
    view.rerenderTerminal({ theme: "light" });
    expect(document.activeElement).toBe(start);
    translationMocks.language = language;
    view.rerenderTerminal({ connectionState: "connecting" });
    expect(screen.getAllByText(t("local.starting")).length).toBeGreaterThan(0);
    view.unmount();
    const admin = renderPreservedTerminal({ session: { ...local, runAsAdmin: true } });
    await waitFor(() => expect(runtimeMocks.install).toHaveBeenCalledTimes(2));
    admin.rerenderTerminal({ connectionState: "connecting" });
    expect(screen.getByText(t("local.waitingAdmin"))).toBeTruthy();
    admin.unmount();
  });

  it("本地轻量恢复接回原通道，不启动进程或请求 UAC", async () => {
    const attachment = preserveTerminal();
    attachment.connection = { ...attachment.connection, sftpAvailable: false, homePath: "C:\\Home", local: { shell: "cmd", elevated: true, label: "CMD" } };
    attachment.currentPath = attachment.connection.homePath;
    apiMocks.attachPreservedTerminal.mockImplementation(async (_id: string, channel: TestChannel<TerminalResumeEvent>) => {
      channel.onmessage({ kind: "snapshot", connectionId: attachment.connection.connectionId, data: btoa("local-screen"), chunkIndex: 0, totalChunks: 1, truncated: false });
      channel.onmessage({ kind: "ready", connectionId: attachment.connection.connectionId, truncated: false }); return attachment;
    });
    const view = renderPreservedTerminal({ session: { kind: "local", id: session.id, name: "CMD", group: "", tags: [], shell: "cmd", startingDirectory: "", runAsAdmin: true } });
    await waitFor(() => expect(view.onConnected).toHaveBeenCalledWith("runtime-preserved", attachment.connection));
    expect(apiMocks.startLocalTerminal).not.toHaveBeenCalled(); expect(apiMocks.connectSession).not.toHaveBeenCalled(); expect(apiMocks.writeTerminal).not.toHaveBeenCalled();
    view.unmount();
  });

});
