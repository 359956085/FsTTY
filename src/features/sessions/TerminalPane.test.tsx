// @vitest-environment jsdom

import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, ShortcutSettings } from "../../shared/api/types";
import { TerminalPane } from "./TerminalPane";

const apiMocks = vi.hoisted(() => ({
  connectSession: vi.fn(),
  disconnectSession: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  install: vi.fn(),
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
  CommandHistoryPopover: () => null,
}));

vi.mock("./terminalRuntime", () => ({
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
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.connectSession.mockReturnValue(new Promise(() => undefined));
    apiMocks.disconnectSession.mockResolvedValue(undefined);
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
      focus: vi.fn(),
      modes: { mouseTrackingMode: "none" },
      onData: vi.fn(),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
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
          directoryRequest={null}
          onConnected={vi.fn()}
          onCredentialSaved={vi.fn()}
          onDirectoryChange={vi.fn()}
          onStateChange={vi.fn()}
          runtimeId="runtime-1"
          session={session}
          shortcuts={shortcuts}
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
});
