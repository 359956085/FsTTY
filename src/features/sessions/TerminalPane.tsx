import { Channel } from "@tauri-apps/api/core";
import { Copy, Link, Link2Off, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { api } from "../../shared/api/client";
import { readApiError, resolveApiError } from "../../shared/api/errors";
import type {
  ConnectionState,
  HostKeyChallenge,
  HostKeyChange,
  Session,
  SshConnection,
  TerminalEvent,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import type { TerminalDirectoryRequest } from "./useSessionConnections";

const SHELL_OSC_IDENTIFIER = 777;

interface ShellIntegration {
  functionName: string;
  stage: "detecting" | "installing" | "active" | "unsupported";
  token: string;
}

interface TerminalPaneProps {
  active: boolean;
  autoConnect: boolean;
  visible: boolean;
  runtimeId: string;
  session: Session;
  connectionState: ConnectionState;
  directoryRequest: TerminalDirectoryRequest | null;
  onConnected: (sessionId: string, connection: SshConnection) => void;
  onDirectoryChange: (sessionId: string, path: string) => void;
  onStateChange: (
    sessionId: string,
    state: ConnectionState,
    error?: string | null,
  ) => void;
}

export function TerminalPane({
  active,
  autoConnect,
  connectionState,
  directoryRequest,
  onConnected,
  onDirectoryChange,
  onStateChange,
  runtimeId,
  session,
  visible,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<XTermFitAddon | null>(null);
  const connectionRef = useRef<SshConnection | null>(null);
  const eventChannelRef = useRef<Channel<TerminalEvent> | null>(null);
  const inputBufferRef = useRef("");
  const inputTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const sendInputRef = useRef<(data: string) => void>(() => undefined);
  const mountedRef = useRef(true);
  const connectionAttemptRef = useRef(0);
  const connectingRef = useRef(false);
  const consumedDirectoryRequestRef = useRef(0);
  const lastReportedDirectoryRef = useRef<string | null>(null);
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  const shellAtPromptRef = useRef(false);
  const shellIntegrationRef = useRef<ShellIntegration | null>(null);
  const [hostKeyChallenge, setHostKeyChallenge] =
    useState<HostKeyChallenge | null>(null);
  const [hostKeyChange, setHostKeyChange] = useState<HostKeyChange | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  onDirectoryChangeRef.current = onDirectoryChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function reportState(state: ConnectionState, error: string | null = null) {
    if (mountedRef.current) {
      onStateChange(runtimeId, state, error);
    }
  }

  function clearPendingInput() {
    if (inputTimerRef.current !== null) {
      window.clearTimeout(inputTimerRef.current);
      inputTimerRef.current = null;
    }
    inputBufferRef.current = "";
    writeChainRef.current = Promise.resolve();
  }

  function resetShellIntegration() {
    lastReportedDirectoryRef.current = null;
    shellAtPromptRef.current = false;
    shellIntegrationRef.current = null;
  }

  function startShellIntegration() {
    // 每次连接使用独立令牌，避免远端普通程序输出相同 OSC 编号时误触发目录同步。
    const token = crypto.randomUUID().replace(/-/g, "");
    shellIntegrationRef.current = {
      functionName: `__fstty_cwd_${token.slice(0, 12)}`,
      stage: "detecting",
      token,
    };
    shellAtPromptRef.current = false;
    lastReportedDirectoryRef.current = null;
    sendImmediateInput(
      ` printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-shell:${token}:%s\\007' "$SHELL"\r`,
    );
  }

  function handleShellOsc(data: string) {
    const integration = shellIntegrationRef.current;
    if (!integration) {
      return true;
    }
    const shellPrefix = `fstty-shell:${integration.token}:`;
    if (data.startsWith(shellPrefix) && integration.stage === "detecting") {
      const shellName = data
        .slice(shellPrefix.length)
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        ?.toLowerCase();
      const command = createShellIntegrationCommand(shellName, integration);
      if (!command) {
        integration.stage = "unsupported";
        return true;
      }
      integration.stage = "installing";
      sendImmediateInput(command);
      return true;
    }
    const directoryPrefix = `fstty-cwd:${integration.token}:`;
    if (!data.startsWith(directoryPrefix)) {
      return true;
    }
    const path = data.slice(directoryPrefix.length);
    if (!isValidRemotePath(path)) {
      return true;
    }
    integration.stage = "active";
    shellAtPromptRef.current = true;
    lastReportedDirectoryRef.current = path;
    onDirectoryChangeRef.current(runtimeId, path);
    return true;
  }

  function flushInput() {
    if (inputTimerRef.current !== null) {
      window.clearTimeout(inputTimerRef.current);
      inputTimerRef.current = null;
    }
    const connection = connectionRef.current;
    const data = inputBufferRef.current;
    inputBufferRef.current = "";
    if (!connection || !data) {
      return;
    }
    const connectionId = connection.connectionId;
    for (const chunk of splitUtf8(data, 64 * 1024)) {
      writeChainRef.current = writeChainRef.current
        .then(() => {
          if (connectionRef.current?.connectionId !== connectionId) {
            return;
          }
          return api.writeTerminal(connectionId, chunk);
        })
        .catch((error: unknown) => {
          if (connectionRef.current?.connectionId !== connectionId) {
            return;
          }
          connectionAttemptRef.current += 1;
          connectionRef.current = null;
          eventChannelRef.current = null;
          clearPendingInput();
          void api.disconnectSession(connectionId).catch(() => undefined);
          reportState("error", resolveApiError(error, t("errors.unknown")));
        });
    }
  }

  function sendImmediateInput(data: string) {
    sendInputRef.current(data);
    flushInput();
  }

  sendInputRef.current = (data) => {
    const connection = connectionRef.current;
    if (!connection && !connectingRef.current) {
      return;
    }
    const nextInput = inputBufferRef.current + data;
    // Shell 首屏可能在连接命令返回前查询终端能力。先缓存 xterm 的自动响应，避免远端登录脚本永久等待。
    if (!connection) {
      if (new TextEncoder().encode(nextInput).byteLength <= 64 * 1024) {
        inputBufferRef.current = nextInput;
      }
      return;
    }
    inputBufferRef.current = nextInput;
    if (new TextEncoder().encode(inputBufferRef.current).byteLength >= 32 * 1024) {
      flushInput();
      return;
    }
    if (inputTimerRef.current === null) {
      inputTimerRef.current = window.setTimeout(flushInput, 16);
    }
  };

  function fitAndResize() {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!terminal || !fitAddon || !container || container.clientWidth === 0) {
      return;
    }
    const buffer = terminal.buffer.active;
    const wasAtBottom = buffer.viewportY === buffer.baseY;
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    // 窗口尺寸变化会重排换行内容。记录视口顶部所在缓冲行，避免用户查看历史时发生跳动。
    const viewportMarker =
      buffer.type === "normal" && !wasAtBottom
        ? terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY)
        : undefined;
    try {
      fitAddon.fit();
    } catch {
      viewportMarker?.dispose();
      return;
    }
    const dimensionsChanged = previousCols !== terminal.cols || previousRows !== terminal.rows;
    if (dimensionsChanged) {
      if (wasAtBottom) {
        terminal.scrollToBottom();
      } else if (viewportMarker && viewportMarker.line >= 0) {
        terminal.scrollToLine(viewportMarker.line);
      }
    }
    viewportMarker?.dispose();
    const connection = connectionRef.current;
    if (!connection || terminal.cols < 1 || terminal.rows < 1) {
      return;
    }
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const currentConnection = connectionRef.current;
      if (currentConnection) {
        void api
          .resizeTerminal(
            currentConnection.connectionId,
            terminal.cols,
            terminal.rows,
          )
          .catch(() => undefined);
      }
    }, 50);
  }

  function focusTerminal() {
    // WebView2 不会稳定把空白终端区域的点击转给 xterm 隐藏输入框。
    terminalRef.current?.focus();
  }

  function restoreTerminalFocus() {
    // 等右键菜单卸载后再聚焦，避免菜单按钮立即把焦点抢回去。
    window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!mountedRef.current || !container || container.getClientRects().length === 0) {
        return;
      }
      focusTerminal();
    });
  }

  async function copyTerminalSelection() {
    try {
      const selection = terminalRef.current?.getSelection() ?? "";
      if (selection) {
        await navigator.clipboard.writeText(selection);
      }
    } catch {
      // 剪贴板权限失败不影响终端继续输入。
    } finally {
      restoreTerminalFocus();
    }
  }

  async function pasteTerminalClipboard() {
    try {
      const value = await navigator.clipboard.readText();
      if (value) {
        sendInputRef.current(value);
      }
    } catch {
      // 剪贴板权限失败不影响终端继续输入。
    } finally {
      restoreTerminalFocus();
    }
  }

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let oscHandler: { dispose(): void } | null = null;
    let terminalInstance: XTerm | null = null;

    async function mountTerminal() {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) {
        return;
      }
      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.38,
        scrollback: 10_000,
        theme: {
          background: "#080d11",
          foreground: "#d5d9dd",
          cursor: "#f1f3f5",
          black: "#111416",
          blue: "#aeb6bd",
          cyan: "#2dd4bf",
          green: "#56cf63",
          red: "#f06b72",
          yellow: "#e5aa4b",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      oscHandler = terminal.parser.registerOscHandler(
        SHELL_OSC_IDENTIFIER,
        handleShellOsc,
      );
      terminal.onData((data) => {
        // 收到目录信号后，只要用户开始输入就不再视为干净提示符，避免自动 cd 污染命令行。
        shellAtPromptRef.current = false;
        sendInputRef.current(data);
      });
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      terminalInstance = terminal;
      observer = new ResizeObserver(fitAndResize);
      observer.observe(container);
      fitAndResize();
      if (autoConnect && !disposed) {
        void connectTerminal();
      }
    }

    void mountTerminal().catch(() => {
      reportState("error", t("sessions.terminalNotReady"));
    });
    return () => {
      disposed = true;
      connectionAttemptRef.current += 1;
      connectingRef.current = false;
      observer?.disconnect();
      oscHandler?.dispose();
      clearPendingInput();
      resetShellIntegration();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) {
        void api.disconnectSession(connection.connectionId).catch(() => undefined);
      }
      eventChannelRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminalInstance?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!directoryRequest || directoryRequest.id === consumedDirectoryRequestRef.current) {
      return;
    }
    consumedDirectoryRequestRef.current = directoryRequest.id;
    if (
      connectionState !== "connected" ||
      !connectionRef.current ||
      shellIntegrationRef.current?.stage !== "active" ||
      !shellAtPromptRef.current ||
      lastReportedDirectoryRef.current === directoryRequest.path ||
      !isValidRemotePath(directoryRequest.path)
    ) {
      return;
    }
    shellAtPromptRef.current = false;
    sendImmediateInput(` builtin cd -- ${quoteShellPath(directoryRequest.path)}\r`);
  }, [connectionState, directoryRequest]);

  useEffect(() => {
    if (!active || !visible) {
      clearPendingInput();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      fitAndResize();
      if (connectionState === "connected") {
        focusTerminal();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, connectionState, visible]);

  async function connectTerminal() {
    if (connectingRef.current || connectionState === "connecting" || connectionRef.current) {
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) {
      reportState("error", t("sessions.terminalNotReady"));
      return;
    }
    clearPendingInput();
    resetShellIntegration();
    terminal.reset();
    const attemptId = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attemptId;
    connectingRef.current = true;
    setDialogError(null);
    setHostKeyChange(null);
    reportState("connecting");
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (event) => {
      if (
        !mountedRef.current ||
        connectionAttemptRef.current !== attemptId ||
        (connectionRef.current &&
          event.connectionId !== connectionRef.current.connectionId)
      ) {
        return;
      }
      if (event.kind === "data") {
        terminalRef.current?.write(decodeBase64(event.data));
        return;
      }
      if (event.kind === "error") {
        connectionAttemptRef.current += 1;
        connectionRef.current = null;
        eventChannelRef.current = null;
        clearPendingInput();
        resetShellIntegration();
        terminalRef.current?.writeln(`\r\n[FsTTY] ${event.message}`);
        reportState("error", event.message);
        return;
      }
      connectionAttemptRef.current += 1;
      connectionRef.current = null;
      eventChannelRef.current = null;
      clearPendingInput();
      resetShellIntegration();
      terminalRef.current?.writeln(`\r\n[FsTTY] ${event.message}`);
      reportState("disconnected");
    };
    eventChannelRef.current = channel;

    try {
      const result = await api.connectSession(
        session.id,
        Math.max(1, terminal.cols),
        Math.max(1, terminal.rows),
        channel,
      );
      if (!mountedRef.current || connectionAttemptRef.current !== attemptId) {
        if (result.kind === "connected") {
          await api
            .disconnectSession(result.connection.connectionId)
            .catch(() => undefined);
        }
        return;
      }
      if (result.kind === "hostKeyRequired") {
        eventChannelRef.current = null;
        clearPendingInput();
        setHostKeyChallenge(result.challenge);
        reportState("disconnected");
        return;
      }
      if (result.kind === "hostKeyChanged") {
        eventChannelRef.current = null;
        clearPendingInput();
        setHostKeyChange(result.change);
        reportState("error", t("sessions.hostKeyChanged"));
        return;
      }
      connectionRef.current = result.connection;
      flushInput();
      onConnected(runtimeId, result.connection);
      startShellIntegration();
      fitAndResize();
    } catch (error) {
      if (!mountedRef.current || connectionAttemptRef.current !== attemptId) {
        return;
      }
      eventChannelRef.current = null;
      clearPendingInput();
      resetShellIntegration();
      const info = readApiError(error, t("errors.unknown"));
      reportState("error", info.message);
    } finally {
      connectingRef.current = false;
    }
  }

  async function disconnectTerminal() {
    const connection = connectionRef.current;
    if (!connection) {
      reportState("disconnected");
      return;
    }
    clearPendingInput();
    resetShellIntegration();
    reportState("disconnecting");
    try {
      await api.disconnectSession(connection.connectionId);
      connectionAttemptRef.current += 1;
      connectionRef.current = null;
      eventChannelRef.current = null;
      clearPendingInput();
      resetShellIntegration();
      reportState("disconnected");
    } catch (error) {
      reportState("error", resolveApiError(error, t("errors.unknown")));
    }
  }

  async function trustAndReconnect() {
    if (!hostKeyChallenge) {
      return;
    }
    try {
      await api.trustHostKey(session.id, hostKeyChallenge.challengeId);
      setHostKeyChallenge(null);
      await connectTerminal();
    } catch (error) {
      setDialogError(resolveApiError(error, t("errors.unknown")));
    }
  }

  return (
    <div className="terminal-wrap">
      <div
        className="terminal-body"
        onContextMenu={(event) => {
          event.preventDefault();
          focusTerminal();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
        onPointerDown={focusTerminal}
        ref={containerRef}
      />
      {connectionState !== "connected" ? (
        <div className="terminal-connect-overlay">
          <Link2Off size={28} />
          <strong>{session.name}</strong>
          <span>
            {connectionState === "connecting"
              ? t("sessions.connecting")
              : t("sessions.manualConnectHint")}
          </span>
          <Button
            className="terminal-connect-button"
            disabled={
              connectionState === "connecting" || connectionState === "disconnecting"
            }
            icon={<Link size={16} />}
            onClick={() => void connectTerminal()}
            variant="ghost"
          >
            {connectionState === "connecting"
              ? t("sessions.connecting")
              : t("sessions.connect")}
          </Button>
        </div>
      ) : null}

      {contextMenu ? (
        <ContextMenu
          items={[
            { id: "copy", label: t("sessions.contextCopy"), icon: <Copy size={15} />, disabled: !(terminalRef.current?.getSelection() ?? ""), onSelect: () => void copyTerminalSelection() },
            { id: "paste", label: t("sessions.contextPaste"), onSelect: () => void pasteTerminalClipboard() },
            { id: "selectAll", label: t("sessions.contextSelectAll"), onSelect: () => terminalRef.current?.selectAll() },
            { id: "clear", label: t("sessions.contextClear"), onSelect: () => terminalRef.current?.clear() },
            { id: "reconnect", label: t("sessions.contextReconnect"), disabled: connectionState === "connected" || connectionState === "connecting", onSelect: () => void connectTerminal() },
            { id: "disconnect", label: t("sessions.disconnect"), disabled: connectionState !== "connected", onSelect: () => void disconnectTerminal() },
          ]}
          onClose={() => setContextMenu(null)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}

      {hostKeyChallenge ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section aria-modal="true" className="dialog security-dialog" role="dialog">
            <header className="dialog-header">
              <ShieldAlert size={20} />
              <h2>{t("sessions.hostKeyTitle")}</h2>
            </header>
            <dl className="security-details">
              <dt>{t("sessions.host")}</dt>
              <dd>{hostKeyChallenge.host}:{hostKeyChallenge.port}</dd>
              <dt>{t("sessions.algorithm")}</dt>
              <dd>{hostKeyChallenge.algorithm}</dd>
              <dt>{t("sessions.fingerprint")}</dt>
              <dd>{hostKeyChallenge.fingerprint}</dd>
            </dl>
            <p>{t("sessions.hostKeyWarning")}</p>
            {dialogError ? <div className="form-error">{dialogError}</div> : null}
            <footer className="dialog-actions">
              <Button onClick={() => setHostKeyChallenge(null)} variant="ghost">
                {t("sessions.cancel")}
              </Button>
              <Button onClick={() => void trustAndReconnect()}>
                {t("sessions.trustAndConnect")}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}

      {hostKeyChange ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section aria-modal="true" className="dialog security-dialog" role="dialog">
            <header className="dialog-header">
              <ShieldAlert size={20} />
              <h2>{t("sessions.hostKeyChanged")}</h2>
            </header>
            <dl className="security-details">
              <dt>{t("sessions.oldFingerprint")}</dt>
              <dd>{hostKeyChange.oldFingerprint}</dd>
              <dt>{t("sessions.newFingerprint")}</dt>
              <dd>{hostKeyChange.newFingerprint}</dd>
            </dl>
            <p>{t("sessions.hostKeyChangedHint")}</p>
            <footer className="dialog-actions">
              <Button onClick={() => setHostKeyChange(null)}>
                {t("sessions.close")}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}

    </div>
  );
}

function decodeBase64(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function createShellIntegrationCommand(
  shellName: string | undefined,
  integration: ShellIntegration,
) {
  // 只修改当前 Shell 进程的提示符钩子，不写入用户远程配置文件。
  const reportDirectory = `printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-cwd:${integration.token}:%s\\007' "$PWD"`;
  if (shellName === "bash") {
    return ` ${integration.functionName}(){ ${reportDirectory}; }; case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in "declare -a"*) PROMPT_COMMAND+=(${integration.functionName});; *) PROMPT_COMMAND="${integration.functionName}\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}";; esac\r`;
  }
  if (shellName === "zsh") {
    return ` ${integration.functionName}(){ ${reportDirectory}; }; precmd_functions+=(${integration.functionName})\r`;
  }
  return null;
}

function isValidRemotePath(path: string) {
  return (
    path.startsWith("/") &&
    new TextEncoder().encode(path).byteLength <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
  );
}

function quoteShellPath(path: string) {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function splitUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}
