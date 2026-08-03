import { Channel } from "@tauri-apps/api/core";
import {
  Copy,
  KeyRound,
  Link,
  Link2Off,
  Save,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
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
import { TextInput } from "../../shared/ui/TextInput";
import { hasControlCharacter } from "../../shared/validation/text";
import type { TerminalDirectoryRequest } from "./useSessionConnections";
import { retryInterruptedAuthentication } from "./authenticationRetry";
import { createImeCompositionFallback } from "./imeCompositionFallback";
import {
  createTerminalLoginInputController,
  type TerminalLoginPromptKind,
} from "./terminalLoginPrompt";
import {
  createRemoteRightDragState,
  shouldOpenLocalTerminalContextMenu,
} from "./terminalContextMenu";
import {
  StrictClipboardBase64,
  TauriClipboardProvider,
  readSystemClipboard,
  resolveTerminalClipboardShortcut,
  writeSystemClipboard,
} from "./terminalClipboard";
import {
  syncTerminalActivity,
  type TerminalActivityController,
} from "./terminalActivity";
import { createTerminalConnectionAttemptGuard } from "./terminalConnectionAttempt";
import { CommandHistoryPopover } from "./CommandHistoryPopover";
import {
  createCommandHistoryInsertion,
  createShellIntegrationCommand,
  parseCommandHistoryOsc,
  type ShellIntegrationDescriptor,
} from "./terminalCommandHistory";

const SHELL_OSC_IDENTIFIER = 777;
const CLIPBOARD_MESSAGE_KEYS = {
  nonText: "sessions.clipboardNonText",
  read: "sessions.clipboardReadFailed",
  write: "sessions.clipboardWriteFailed",
} as const;
type ClipboardMessageKind = keyof typeof CLIPBOARD_MESSAGE_KEYS;

interface ShellIntegration extends ShellIntegrationDescriptor {
  stage: "detecting" | "installing" | "active" | "unsupported";
}

interface ConnectTerminalOptions {
  fromCredentialPrompt?: boolean;
  oneTimeCredential?: string;
  oneTimeUsername?: string;
}

interface TemporaryLogin {
  password?: string;
  usedPassword: boolean;
  usedUsername: boolean;
  username?: string;
}

type LoginSavePromptKind = "username" | "password" | "both";

interface TerminalPaneProps {
  active: boolean;
  allowRemoteClipboardWrite: boolean;
  autoConnect: boolean;
  visible: boolean;
  runtimeId: string;
  session: Session;
  connectionState: ConnectionState;
  directoryRequest: TerminalDirectoryRequest | null;
  onConnected: (sessionId: string, connection: SshConnection) => void;
  onCredentialSaved: () => Promise<void> | void;
  onDirectoryChange: (sessionId: string, path: string) => void;
  onStateChange: (
    sessionId: string,
    state: ConnectionState,
    error?: string | null,
  ) => void;
}

export const TerminalPane = memo(function TerminalPane({
  active,
  allowRemoteClipboardWrite,
  autoConnect,
  connectionState,
  directoryRequest,
  onConnected,
  onCredentialSaved,
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
  const clipboardErrorTimerRef = useRef<number | null>(null);
  const imeCompositionFallbackRef = useRef<ReturnType<
    typeof createImeCompositionFallback
  > | null>(null);
  const remoteRightDragStateRef = useRef(createRemoteRightDragState());
  const remoteMouseActivityRef = useRef<TerminalActivityController | null>(null);
  const resizeObserverActivityRef = useRef<TerminalActivityController | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const historyWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const sendInputRef = useRef<(data: string) => void>(() => undefined);
  const terminalLoginInputRef = useRef(createTerminalLoginInputController());
  const temporaryLoginRef = useRef<TemporaryLogin | null>(null);
  const handleTerminalLoginDataRef = useRef<(data: string) => boolean>(() => false);
  const mountedRef = useRef(true);
  const connectionAttemptGuardRef = useRef(createTerminalConnectionAttemptGuard());
  const consumedDirectoryRequestRef = useRef(0);
  const lastReportedDirectoryRef = useRef<string | null>(null);
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  const onCredentialSavedRef = useRef(onCredentialSaved);
  const shellAtPromptRef = useRef(false);
  const shellIntegrationRef = useRef<ShellIntegration | null>(null);
  const autoConnectRef = useRef(autoConnect);
  const connectTerminalRef = useRef<(options?: ConnectTerminalOptions) => Promise<void>>(
    async () => undefined,
  );
  const handleShellOscRef = useRef<(data: string) => boolean>(() => true);
  const reportStateRef = useRef<
    (state: ConnectionState, error?: string | null) => void
  >(() => undefined);
  const sendImmediateInputRef = useRef<(data: string) => void>(() => undefined);
  const translateRef = useRef(t);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const allowRemoteClipboardWriteRef = useRef(allowRemoteClipboardWrite);
  const reportClipboardErrorRef = useRef<() => void>(() => undefined);
  const copyTerminalSelectionRef = useRef<() => Promise<void>>(async () => undefined);
  const pasteTerminalClipboardRef = useRef<() => Promise<void>>(async () => undefined);
  const [hostKeyChallenge, setHostKeyChallenge] =
    useState<HostKeyChallenge | null>(null);
  const [hostKeyChange, setHostKeyChange] = useState<HostKeyChange | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [credentialPrompt, setCredentialPrompt] =
    useState<"privateKeyPassphrase" | null>(null);
  const [credentialValue, setCredentialValue] = useState("");
  const [rememberCredential, setRememberCredential] = useState(true);
  const [credentialSubmitting, setCredentialSubmitting] = useState(false);
  const [terminalLoginPrompt, setTerminalLoginPrompt] =
    useState<TerminalLoginPromptKind | null>(null);
  const [loginSavePrompt, setLoginSavePrompt] = useState<LoginSavePromptKind | null>(null);
  const [loginSaveSubmitting, setLoginSaveSubmitting] = useState(false);
  const [loginSaveError, setLoginSaveError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboardError, setClipboardError] = useState<ClipboardMessageKind | null>(null);

  onDirectoryChangeRef.current = onDirectoryChange;
  onCredentialSavedRef.current = onCredentialSaved;
  // 终端实例只挂载一次；通过 ref 读取最新回调，避免属性变化时销毁现有 SSH 连接。
  autoConnectRef.current = autoConnect;
  connectTerminalRef.current = connectTerminal;
  handleShellOscRef.current = handleShellOsc;
  reportStateRef.current = reportState;
  sendImmediateInputRef.current = sendImmediateInput;
  translateRef.current = t;
  activeRef.current = active;
  visibleRef.current = visible;
  allowRemoteClipboardWriteRef.current = allowRemoteClipboardWrite;
  reportClipboardErrorRef.current = reportClipboardError;
  copyTerminalSelectionRef.current = copyTerminalSelection;
  pasteTerminalClipboardRef.current = pasteTerminalClipboard;
  handleTerminalLoginDataRef.current = handleTerminalLoginData;

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

  function clearTemporaryLogin() {
    terminalLoginInputRef.current.reset();
    temporaryLoginRef.current = null;
    if (mountedRef.current) {
      setTerminalLoginPrompt(null);
      setLoginSavePrompt(null);
      setLoginSaveError(null);
      setLoginSaveSubmitting(false);
    }
  }

  function beginTerminalLoginPrompt(kind: TerminalLoginPromptKind) {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminalLoginInputRef.current.start(kind);
    setTerminalLoginPrompt(kind);
    terminal.write(
      `[FsTTY] ${t(
        kind === "username"
          ? "sessions.terminalUsernamePrompt"
          : "sessions.terminalPasswordPrompt",
      )}`,
    );
    terminal.focus();
  }

  function handleTerminalLoginData(data: string) {
    const controller = terminalLoginInputRef.current;
    if (!controller.getPrompt()) {
      return false;
    }
    const terminal = terminalRef.current;
    const result = controller.handle(data);
    if (result.echo) {
      terminal?.write(result.echo);
    }
    if (result.kind === "pending") {
      return true;
    }
    setTerminalLoginPrompt(null);
    if (result.kind === "cancel") {
      clearTemporaryLogin();
      terminal?.writeln(`[FsTTY] ${t("sessions.terminalLoginCancelled")}`);
      reportState("disconnected");
      return true;
    }

    if (result.prompt === "username") {
      const username = result.value.trim();
      if (!username || username.length > 128 || hasControlCharacter(username)) {
        terminal?.writeln(`[FsTTY] ${t("sessions.terminalUsernameInvalid")}`);
        beginTerminalLoginPrompt("username");
        return true;
      }
      temporaryLoginRef.current = {
        password: temporaryLoginRef.current?.password,
        usedPassword: temporaryLoginRef.current?.usedPassword ?? false,
        usedUsername: true,
        username,
      };
      void connectTerminalRef.current({ oneTimeUsername: username });
      return true;
    }

    if (!result.value) {
      terminal?.writeln(`[FsTTY] ${t("sessions.terminalPasswordRequired")}`);
      beginTerminalLoginPrompt("password");
      return true;
    }
    const current = temporaryLoginRef.current;
    temporaryLoginRef.current = {
      password: result.value,
      usedPassword: true,
      usedUsername: current?.usedUsername ?? false,
      username: current?.username,
    };
    void connectTerminalRef.current({
      fromCredentialPrompt: true,
      oneTimeCredential: result.value,
      oneTimeUsername: current?.username,
    });
    return true;
  }

  function reportClipboardError(kind: ClipboardMessageKind = "write") {
    if (!mountedRef.current) {
      return;
    }
    setClipboardError(kind);
    if (clipboardErrorTimerRef.current !== null) {
      window.clearTimeout(clipboardErrorTimerRef.current);
    }
    clipboardErrorTimerRef.current = window.setTimeout(() => {
      clipboardErrorTimerRef.current = null;
      if (mountedRef.current) {
        setClipboardError(null);
      }
    }, 3000);
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
      historyFunctionName: `__fstty_history_${token.slice(0, 12)}`,
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
    const history = parseCommandHistoryOsc(data, integration);
    if (history.matched) {
      if (history.command) {
        historyWriteChainRef.current = historyWriteChainRef.current
          .then(() => api.addCommandHistory(history.command!))
          .catch((error) => {
            // 历史库故障不能阻塞远程终端；链继续可用，便于后续命令自动恢复写入。
            console.error("历史命令保存失败", error);
          });
      }
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
          connectionAttemptGuardRef.current.invalidate();
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
    if (!connection && !connectionAttemptGuardRef.current.isConnecting()) {
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
    if (
      !activeRef.current ||
      !visibleRef.current ||
      !terminal ||
      !fitAddon ||
      !container ||
      container.clientWidth === 0
    ) {
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
      if (currentConnection && activeRef.current && visibleRef.current) {
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
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? "";
    if (!terminal || !selection) {
      return;
    }
    try {
      await writeSystemClipboard(selection);
      if (mountedRef.current && terminalRef.current === terminal) {
        terminal.clearSelection();
      }
    } catch {
      reportClipboardError();
    } finally {
      restoreTerminalFocus();
    }
  }

  async function pasteTerminalClipboard() {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    try {
      const contentKind = await api.getSystemClipboardContentKind();
      if (
        !mountedRef.current ||
        !activeRef.current ||
        !visibleRef.current ||
        terminalRef.current !== terminal
      ) {
        return;
      }
      if (contentKind === "empty") {
        return;
      }
      if (contentKind === "nonText") {
        reportClipboardError("nonText");
        return;
      }
      const value = await readSystemClipboard();
      if (
        value &&
        mountedRef.current &&
        activeRef.current &&
        visibleRef.current &&
        terminalRef.current === terminal
      ) {
        terminal.clearSelection();
        terminal.paste(value);
      }
    } catch {
      reportClipboardError("read");
    } finally {
      restoreTerminalFocus();
    }
  }

  useEffect(() => {
    let disposed = false;
    const connectionAttemptGuard = connectionAttemptGuardRef.current;
    let observer: ResizeObserver | null = null;
    let oscHandler: { dispose(): void } | null = null;
    let terminalInstance: XTerm | null = null;
    let disposeImeListeners: (() => void) | null = null;
    let remoteMouseListenersAttached = false;
    let resizeObserverActive = false;
    const terminalLoginInput = terminalLoginInputRef.current;

    async function mountTerminal() {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const [{ Terminal }, { FitAddon }, { ClipboardAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-clipboard"),
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
      terminal.loadAddon(
        new ClipboardAddon(
          new StrictClipboardBase64(),
          new TauriClipboardProvider({
            isAllowed: () =>
              allowRemoteClipboardWriteRef.current &&
              activeRef.current &&
              visibleRef.current,
            onWriteError: () => reportClipboardErrorRef.current(),
          }),
        ),
      );
      terminal.open(container);
      const remoteRightDragState = remoteRightDragStateRef.current;
      const syntheticMouseMoves = new WeakSet<Event>();
      const syntheticMouseReleases = new WeakSet<Event>();
      let capturedRemotePointerId: number | null = null;
      let lastRemotePointerEvent: MouseEvent | null = null;
      let remoteReleaseFallbackTimer: number | null = null;
      const clearRemoteReleaseFallback = () => {
        if (remoteReleaseFallbackTimer !== null) {
          window.clearTimeout(remoteReleaseFallbackTimer);
          remoteReleaseFallbackTimer = null;
        }
      };
      const releaseRemotePointerCapture = () => {
        const pointerId = capturedRemotePointerId;
        capturedRemotePointerId = null;
        const terminalElement = terminal.element;
        if (pointerId === null || !terminalElement) {
          return;
        }
        try {
          if (terminalElement.hasPointerCapture(pointerId)) {
            terminalElement.releasePointerCapture(pointerId);
          }
        } catch {
          // pointerup 可能已让 WebView2 自动释放捕获，无需再次处理。
        }
      };
      const resetRemoteRightDrag = () => {
        clearRemoteReleaseFallback();
        // 先结束状态，防止主动释放捕获产生的 lostpointercapture 补发释放。
        remoteRightDragState.end();
        lastRemotePointerEvent = null;
        releaseRemotePointerCapture();
      };
      const dispatchRemoteListenerRearm = (event: MouseEvent) => {
        const terminalElement = terminal.element;
        if (!terminalElement) {
          resetRemoteRightDrag();
          return false;
        }
        // xterm 切换鼠标协议后只会在下一次 mousedown 重新绑定 document 监听。
        // 补发一次右键按下，让当前 tmux 手势继续拥有移动和释放监听。
        terminalElement.dispatchEvent(
          new MouseEvent("mousedown", {
            altKey: event.altKey,
            bubbles: true,
            button: 2,
            buttons: 2,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
            composed: true,
            ctrlKey: event.ctrlKey,
            detail: event.detail,
            metaKey: event.metaKey,
            relatedTarget: event.relatedTarget,
            screenX: event.screenX,
            screenY: event.screenY,
            shiftKey: event.shiftKey,
            view: window,
          }),
        );
        return true;
      };
      const handleRemotePointerDown = (event: PointerEvent) => {
        const target = event.target;
        const mouseTrackingMode = terminal.modes.mouseTrackingMode;
        const enabled =
          event.pointerType === "mouse" &&
          activeRef.current &&
          visibleRef.current &&
          connectionRef.current !== null &&
          target instanceof Node &&
          container.contains(target);
        resetRemoteRightDrag();
        remoteRightDragState.begin({
          button: event.button,
          enabled,
          mouseTrackingMode,
          pointerId: event.pointerId,
          shiftKey: event.shiftKey,
        });
        if (!enabled || event.button !== 2 || event.shiftKey || mouseTrackingMode === "none") {
          return;
        }
        lastRemotePointerEvent = event;
        const terminalElement = terminal.element;
        if (!terminalElement) {
          return;
        }
        try {
          // 固定后续 pointerup 到终端，避免 WebView2 在右键拖动后吞掉释放事件。
          terminalElement.setPointerCapture(event.pointerId);
          capturedRemotePointerId = event.pointerId;
        } catch {
          // 捕获失败时继续依赖窗口级 pointerup 和 mouseup 兜底。
        }
      };
      const handleRemoteMouseMove = (event: MouseEvent) => {
        const action = remoteRightDragState.getMoveAction(
          terminal.modes.mouseTrackingMode,
          event.buttons,
          syntheticMouseMoves.has(event),
        );
        if (action.kind === "ignore") {
          return;
        }
        lastRemotePointerEvent = event;
        if (action.kind === "passthrough") {
          // Pointer Capture 已保留正确右键位时，必须让 xterm 的原生拖动监听器直接处理。
          return;
        }
        const terminalElement = terminal.element;
        if (!terminalElement) {
          resetRemoteRightDrag();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (
          action.kind === "rearmAndRedispatchRightDrag" &&
          !dispatchRemoteListenerRearm(event)
        ) {
          return;
        }
        // 重建监听后必须重发当前位置；普通修复则只补回 WebView2 丢失的右键位。
        const repairedEvent = new MouseEvent("mousemove", {
          altKey: event.altKey,
          bubbles: true,
          button: 0,
          buttons: 2,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          composed: true,
          ctrlKey: event.ctrlKey,
          detail: event.detail,
          metaKey: event.metaKey,
          relatedTarget: event.relatedTarget,
          screenX: event.screenX,
          screenY: event.screenY,
          shiftKey: event.shiftKey,
          view: window,
        });
        syntheticMouseMoves.add(repairedEvent);
        terminalElement.dispatchEvent(repairedEvent);
      };
      const dispatchFallbackRemoteMouseUp = (
        event: MouseEvent,
        pointerId?: number,
      ) => {
        clearRemoteReleaseFallback();
        const action = remoteRightDragState.getFallbackReleaseAction(pointerId);
        if (action.kind === "ignore") {
          return;
        }
        const terminalElement = terminal.element;
        if (!terminalElement) {
          resetRemoteRightDrag();
          return;
        }
        const repairedEvent = new MouseEvent("mouseup", {
          altKey: event.altKey,
          bubbles: true,
          button: action.button,
          buttons: action.buttons,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          composed: true,
          ctrlKey: event.ctrlKey,
          detail: event.detail,
          metaKey: event.metaKey,
          relatedTarget: event.relatedTarget,
          screenX: event.screenX,
          screenY: event.screenY,
          shiftKey: event.shiftKey,
          view: window,
        });
        syntheticMouseReleases.add(repairedEvent);
        terminalElement.dispatchEvent(repairedEvent);
        // xterm 的 mouseup 监听器位于事件传播后段；微任务确保释放先发给远端。
        queueMicrotask(resetRemoteRightDrag);
      };
      const scheduleFallbackRemoteMouseUp = (
        event: MouseEvent,
        pointerId?: number,
      ) => {
        lastRemotePointerEvent = event;
        clearRemoteReleaseFallback();
        remoteReleaseFallbackTimer = window.setTimeout(() => {
          remoteReleaseFallbackTimer = null;
          dispatchFallbackRemoteMouseUp(event, pointerId);
        }, 0);
      };
      const handleRemotePointerUp = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") {
          return;
        }
        const action = remoteRightDragState.getPointerUpAction(
          terminal.modes.mouseTrackingMode,
          event.pointerId,
        );
        if (action.kind === "ignore") {
          return;
        }
        if (
          action.kind === "rearmListeners" &&
          !dispatchRemoteListenerRearm(event)
        ) {
          return;
        }
        // 浏览器通常紧接着派发 mouseup；延迟兜底可避免抢在原生事件前重复释放。
        scheduleFallbackRemoteMouseUp(event, event.pointerId);
      };
      const handleRemoteMouseUp = (event: MouseEvent) => {
        const action = remoteRightDragState.getNativeReleaseAction(
          event.button,
          syntheticMouseReleases.has(event),
        );
        if (action.kind === "ignore") {
          return;
        }
        lastRemotePointerEvent = event;
        if (action.kind === "passthrough") {
          clearRemoteReleaseFallback();
          // 原生事件继续传播给 xterm，随后再清理状态。
          queueMicrotask(resetRemoteRightDrag);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        scheduleFallbackRemoteMouseUp(event);
      };
      const handleRemotePointerCancel = (event: PointerEvent) => {
        clearRemoteReleaseFallback();
        remoteRightDragState.cancelPointer(event.pointerId);
        if (capturedRemotePointerId === event.pointerId) {
          releaseRemotePointerCapture();
        }
      };
      const handleLostRemotePointerCapture = (event: PointerEvent) => {
        if (capturedRemotePointerId === event.pointerId) {
          capturedRemotePointerId = null;
        }
        if (event.buttons === 0) {
          scheduleFallbackRemoteMouseUp(
            lastRemotePointerEvent ?? event,
            event.pointerId,
          );
        }
      };
      const startRemoteMouseListeners = () => {
        if (remoteMouseListenersAttached) {
          return;
        }
        remoteMouseListenersAttached = true;
        // WebView2 右键手势可能破坏后续 MouseEvent.buttons；PointerEvent 用于可靠记录按下状态。
        window.addEventListener("pointerdown", handleRemotePointerDown, true);
        window.addEventListener("pointerup", handleRemotePointerUp, true);
        window.addEventListener("mousemove", handleRemoteMouseMove, true);
        window.addEventListener("mouseup", handleRemoteMouseUp, true);
        window.addEventListener("pointercancel", handleRemotePointerCancel, true);
        terminal.element?.addEventListener(
          "lostpointercapture",
          handleLostRemotePointerCapture,
        );
        window.addEventListener("blur", resetRemoteRightDrag);
      };
      const stopRemoteMouseListeners = () => {
        if (!remoteMouseListenersAttached) {
          resetRemoteRightDrag();
          return;
        }
        remoteMouseListenersAttached = false;
        window.removeEventListener("pointerdown", handleRemotePointerDown, true);
        window.removeEventListener("pointerup", handleRemotePointerUp, true);
        window.removeEventListener("mousemove", handleRemoteMouseMove, true);
        window.removeEventListener("mouseup", handleRemoteMouseUp, true);
        window.removeEventListener("pointercancel", handleRemotePointerCancel, true);
        terminal.element?.removeEventListener(
          "lostpointercapture",
          handleLostRemotePointerCapture,
        );
        window.removeEventListener("blur", resetRemoteRightDrag);
        resetRemoteRightDrag();
      };
      const remoteMouseActivity = {
        start: startRemoteMouseListeners,
        stop: stopRemoteMouseListeners,
      };
      remoteMouseActivityRef.current = remoteMouseActivity;
      const textarea = terminal.textarea;
      if (textarea) {
        const imeCompositionFallback = createImeCompositionFallback();
        const handleInputCapture = (event: Event) => {
          if (!(event instanceof InputEvent) || event.target !== textarea) {
            return;
          }
          const finalInput = imeCompositionFallback.takeFinalInput(event);
          if (finalInput === null) {
            return;
          }
          // WebView2 已给出完整最终文字；阻止 xterm 因 Shift 状态忽略后，走公开输入接口提交。
          event.stopPropagation();
          terminal.input(finalInput, true);
        };
        textarea.addEventListener("compositionstart", imeCompositionFallback.compositionStart);
        textarea.addEventListener("compositionend", imeCompositionFallback.compositionEnd);
        textarea.addEventListener("keydown", imeCompositionFallback.handleKeyDown);
        textarea.addEventListener("keyup", imeCompositionFallback.handleKeyUp);
        textarea.addEventListener("blur", imeCompositionFallback.reset);
        container.addEventListener("input", handleInputCapture, true);
        imeCompositionFallbackRef.current = imeCompositionFallback;
        disposeImeListeners = () => {
          textarea.removeEventListener(
            "compositionstart",
            imeCompositionFallback.compositionStart,
          );
          textarea.removeEventListener("compositionend", imeCompositionFallback.compositionEnd);
          textarea.removeEventListener("keydown", imeCompositionFallback.handleKeyDown);
          textarea.removeEventListener("keyup", imeCompositionFallback.handleKeyUp);
          textarea.removeEventListener("blur", imeCompositionFallback.reset);
          container.removeEventListener("input", handleInputCapture, true);
          imeCompositionFallback.dispose();
          if (imeCompositionFallbackRef.current === imeCompositionFallback) {
            imeCompositionFallbackRef.current = null;
          }
        };
      }
      terminal.attachCustomKeyEventHandler((event) => {
        const action = resolveTerminalClipboardShortcut(event, terminal.hasSelection());
        if (action === "copy") {
          event.preventDefault();
          event.stopPropagation();
          void copyTerminalSelectionRef.current();
          return false;
        }
        if (action === "paste") {
          event.preventDefault();
          event.stopPropagation();
          void pasteTerminalClipboardRef.current();
          return false;
        }
        return true;
      });
      oscHandler = terminal.parser.registerOscHandler(
        SHELL_OSC_IDENTIFIER,
        (data) => handleShellOscRef.current(data),
      );
      terminal.onData((data) => {
        if (handleTerminalLoginDataRef.current(data)) {
          return;
        }
        // 收到目录信号后，只要用户开始输入就不再视为干净提示符，避免自动 cd 污染命令行。
        shellAtPromptRef.current = false;
        sendInputRef.current(data);
      });
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      terminalInstance = terminal;
      observer = new ResizeObserver(fitAndResize);
      const resizeObserverActivity = {
        start: () => {
          if (resizeObserverActive) {
            return;
          }
          resizeObserverActive = true;
          observer?.observe(container);
        },
        stop: () => {
          if (!resizeObserverActive) {
            if (resizeTimerRef.current !== null) {
              window.clearTimeout(resizeTimerRef.current);
              resizeTimerRef.current = null;
            }
            return;
          }
          resizeObserverActive = false;
          observer?.disconnect();
          if (resizeTimerRef.current !== null) {
            window.clearTimeout(resizeTimerRef.current);
            resizeTimerRef.current = null;
          }
        },
      };
      resizeObserverActivityRef.current = resizeObserverActivity;
      if (activeRef.current && visibleRef.current) {
        resizeObserverActivity.start();
        fitAndResize();
      }
      if (autoConnectRef.current && !disposed) {
        void connectTerminalRef.current();
      }
    }

    void mountTerminal().catch(() => {
      reportStateRef.current("error", translateRef.current("sessions.terminalNotReady"));
    });
    return () => {
      disposed = true;
      connectionAttemptGuard.invalidate();
      resizeObserverActivityRef.current?.stop();
      resizeObserverActivityRef.current = null;
      oscHandler?.dispose();
      clearPendingInput();
      resetShellIntegration();
      terminalLoginInput.reset();
      temporaryLoginRef.current = null;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      if (clipboardErrorTimerRef.current !== null) {
        window.clearTimeout(clipboardErrorTimerRef.current);
        clipboardErrorTimerRef.current = null;
      }
      disposeImeListeners?.();
      disposeImeListeners = null;
      remoteMouseActivityRef.current?.stop();
      remoteMouseActivityRef.current = null;
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
    sendImmediateInputRef.current(
      ` builtin cd -- ${quoteShellPath(directoryRequest.path)}\r`,
    );
  }, [connectionState, directoryRequest]);

  useEffect(() => {
    const resizeObserverActivity = resizeObserverActivityRef.current;
    const remoteMouseActivity = remoteMouseActivityRef.current;
    const activity = syncTerminalActivity({
      active,
      connected: connectionState === "connected",
      remoteMouse: remoteMouseActivity,
      resizeObserver: resizeObserverActivity,
      visible,
    });
    if (activity.shouldResetInteraction) {
      remoteRightDragStateRef.current.end();
    }
    if (!activity.shouldFit) {
      clearTemporaryLogin();
      terminalRef.current?.blur();
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

  async function connectTerminal(options: ConnectTerminalOptions = {}) {
    const { fromCredentialPrompt = false, oneTimeCredential } = options;
    if (
      connectionAttemptGuardRef.current.isConnecting() ||
      connectionState === "connecting" ||
      connectionRef.current
    ) {
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) {
      reportState("error", t("sessions.terminalNotReady"));
      return;
    }
    const oneTimeUsername =
      options.oneTimeUsername ?? temporaryLoginRef.current?.username;
    if (!session.username.trim() && !oneTimeUsername) {
      if (session.auth.kind !== "password") {
        reportState("error", t("sessions.usernameRequired"));
        return;
      }
      clearPendingInput();
      resetShellIntegration();
      imeCompositionFallbackRef.current?.reset();
      terminal.reset();
      temporaryLoginRef.current = {
        usedPassword: false,
        usedUsername: false,
      };
      reportState("disconnected");
      beginTerminalLoginPrompt("username");
      return;
    }
    clearPendingInput();
    resetShellIntegration();
    imeCompositionFallbackRef.current?.reset();
    terminal.reset();
    const attemptId = connectionAttemptGuardRef.current.begin();
    setDialogError(null);
    setHostKeyChange(null);
    reportState("connecting");
    const isCurrentAttempt = () =>
      mountedRef.current && connectionAttemptGuardRef.current.isCurrent(attemptId);
    const canRetryAttempt = () => isCurrentAttempt() && activeRef.current;
    const runConnectAttempt = () => {
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = (event) => {
        if (
          !isCurrentAttempt() ||
          eventChannelRef.current !== channel ||
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
          connectionAttemptGuardRef.current.invalidate();
          connectionRef.current = null;
          eventChannelRef.current = null;
          clearPendingInput();
          resetShellIntegration();
          clearTemporaryLogin();
          terminalRef.current?.writeln(`\r\n[FsTTY] ${event.message}`);
          reportState("error", event.message);
          return;
        }
        connectionAttemptGuardRef.current.invalidate();
        connectionRef.current = null;
        eventChannelRef.current = null;
        clearPendingInput();
        resetShellIntegration();
        clearTemporaryLogin();
        terminalRef.current?.writeln(`\r\n[FsTTY] ${event.message}`);
        reportState("disconnected");
      };
      eventChannelRef.current = channel;
      return api.connectSession(
        session.id,
        Math.max(1, terminal.cols),
        Math.max(1, terminal.rows),
        channel,
        oneTimeCredential,
        oneTimeUsername,
      );
    };

    try {
      const result = await retryInterruptedAuthentication(
        runConnectAttempt,
        canRetryAttempt,
      );
      if (!result) {
        eventChannelRef.current = null;
        clearPendingInput();
        resetShellIntegration();
        reportState("disconnected");
        return;
      }
      if (!mountedRef.current || !connectionAttemptGuardRef.current.isCurrent(attemptId)) {
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
        clearTemporaryLogin();
        reportState("error", t("sessions.hostKeyChanged"));
        return;
      }
      if (result.kind === "credentialRequired") {
        eventChannelRef.current = null;
        clearPendingInput();
        resetShellIntegration();
        if (
          result.credentialKind === "password" &&
          session.auth.kind === "password"
        ) {
          beginTerminalLoginPrompt("password");
        } else {
          setCredentialPrompt("privateKeyPassphrase");
          setCredentialValue("");
          setRememberCredential(true);
          setDialogError(null);
        }
        reportState("disconnected");
        return;
      }
      connectionRef.current = result.connection;
      setCredentialPrompt(null);
      setCredentialValue("");
      setDialogError(null);
      flushInput();
      onConnected(runtimeId, result.connection);
      const temporaryLogin = temporaryLoginRef.current;
      if (
        temporaryLogin &&
        !session.loginSavePrompted &&
        (temporaryLogin.usedUsername || temporaryLogin.usedPassword)
      ) {
        setLoginSavePrompt(
          temporaryLogin.usedUsername && temporaryLogin.usedPassword
            ? "both"
            : temporaryLogin.usedUsername
              ? "username"
              : "password",
        );
        setLoginSaveError(null);
      } else {
        clearTemporaryLogin();
      }
      startShellIntegration();
      fitAndResize();
    } catch (error) {
      if (!mountedRef.current || !connectionAttemptGuardRef.current.isCurrent(attemptId)) {
        return;
      }
      eventChannelRef.current = null;
      clearPendingInput();
      resetShellIntegration();
      const info = readApiError(error, t("errors.unknown"));
      const message =
        info.kind === "authenticationInterrupted"
          ? t("sessions.authenticationInterrupted")
          : info.kind === "authenticationRejected"
            ? t(
                session.auth.kind === "password"
                  ? "sessions.passwordAuthenticationRejected"
                  : "sessions.privateKeyAuthenticationRejected",
              )
            : info.message;
      if (
        fromCredentialPrompt &&
        session.auth.kind === "password" &&
        info.kind === "authenticationRejected"
      ) {
        const current = temporaryLoginRef.current;
        temporaryLoginRef.current = current
          ? { ...current, password: undefined }
          : { usedPassword: false, usedUsername: false };
        terminal.writeln(`\r\n[FsTTY] ${message}`);
        beginTerminalLoginPrompt("password");
        reportState("disconnected");
      } else if (fromCredentialPrompt && session.auth.kind === "privateKey") {
        setDialogError(message);
        reportState("disconnected");
      } else {
        clearTemporaryLogin();
        reportState("error", message);
      }
    } finally {
      connectionAttemptGuardRef.current.finish(attemptId);
    }
  }

  async function submitCredential() {
    if (!credentialPrompt || credentialSubmitting) {
      return;
    }
    if (!credentialValue) {
      setDialogError(t("sessions.credentialPassphrasePrompt"));
      return;
    }
    setCredentialSubmitting(true);
    setDialogError(null);
    try {
      if (rememberCredential) {
        await api.setSessionCredential(session.id, credentialValue);
        await onCredentialSavedRef.current();
        await connectTerminal({ fromCredentialPrompt: true });
      } else {
        await connectTerminal({
          fromCredentialPrompt: true,
          oneTimeCredential: credentialValue,
        });
      }
    } catch (error) {
      setDialogError(resolveApiError(error, t("errors.unknown")));
    } finally {
      setCredentialSubmitting(false);
    }
  }

  function closeCredentialPrompt() {
    setCredentialPrompt(null);
    setCredentialValue("");
    setDialogError(null);
    clearTemporaryLogin();
    reportState("disconnected");
  }

  async function resolveLoginSavePrompt(save: boolean) {
    if (!loginSavePrompt || loginSaveSubmitting) {
      return;
    }
    const temporaryLogin = temporaryLoginRef.current;
    if (save && !temporaryLogin) {
      setLoginSaveError(t("sessions.loginSaveExpired"));
      return;
    }
    setLoginSaveSubmitting(true);
    setLoginSaveError(null);
    try {
      await api.resolveSessionLoginSavePrompt(
        session.id,
        save
          ? {
              mode: "save",
              username: temporaryLogin?.usedUsername
                ? temporaryLogin.username
                : undefined,
              password: temporaryLogin?.usedPassword
                ? temporaryLogin.password
                : undefined,
            }
          : { mode: "decline" },
      );
      await onCredentialSavedRef.current();
      clearTemporaryLogin();
      restoreTerminalFocus();
    } catch (error) {
      setLoginSaveError(resolveApiError(error, t("errors.unknown")));
    } finally {
      if (mountedRef.current) {
        setLoginSaveSubmitting(false);
      }
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
      connectionAttemptGuardRef.current.invalidate();
      connectionRef.current = null;
      eventChannelRef.current = null;
      clearPendingInput();
      resetShellIntegration();
      clearTemporaryLogin();
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
        onContextMenuCapture={(event) => {
          event.preventDefault();
          // 必须在捕获阶段跳过 xterm 的本地右键处理，避免隐藏 textarea 打断远端拖动。
          event.stopPropagation();
          const mouseTrackingMode =
            terminalRef.current?.modes.mouseTrackingMode ?? "none";
          if (!shouldOpenLocalTerminalContextMenu(mouseTrackingMode, event.shiftKey)) {
            // 手势只由真实 pointerdown 建立，避免 mouseup 后的 contextmenu 重新激活已结束状态。
            setContextMenu(null);
            return;
          }
          focusTerminal();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
        onPointerDown={focusTerminal}
        ref={containerRef}
      />
      <div className="terminal-toolbar">
        <CommandHistoryPopover
          disabled={connectionState !== "connected"}
          onSelect={(command) => {
            sendImmediateInput(createCommandHistoryInsertion(command));
            window.requestAnimationFrame(focusTerminal);
          }}
        />
      </div>
      {clipboardError ? (
        <div aria-live="polite" className="terminal-clipboard-error error-banner">
          {t(CLIPBOARD_MESSAGE_KEYS[clipboardError])}
        </div>
      ) : null}
      {connectionState !== "connected" && !terminalLoginPrompt ? (
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
            icon={<Link aria-hidden="true" size={16} />}
            onClick={() => void connectTerminal()}
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

      {loginSavePrompt ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section aria-modal="true" className="dialog credential-dialog" role="dialog">
            <header className="dialog-header">
              <UserRound size={20} />
              <h2>{t("sessions.loginSaveTitle")}</h2>
            </header>
            <div className="credential-dialog-body">
              <p>
                {t(
                  loginSavePrompt === "both"
                    ? "sessions.loginSaveBothPrompt"
                    : loginSavePrompt === "username"
                      ? "sessions.loginSaveUsernamePrompt"
                      : "sessions.loginSavePasswordPrompt",
                )}
              </p>
              <small>{t("sessions.loginSaveOnceHint")}</small>
            </div>
            {loginSaveError ? <div className="form-error">{loginSaveError}</div> : null}
            <footer className="dialog-actions">
              <Button
                disabled={loginSaveSubmitting}
                onClick={() => void resolveLoginSavePrompt(false)}
                variant="ghost"
              >
                {t("sessions.doNotSave")}
              </Button>
              <Button
                disabled={loginSaveSubmitting}
                icon={<Save aria-hidden="true" size={16} />}
                onClick={() => void resolveLoginSavePrompt(true)}
              >
                {t(
                  loginSavePrompt === "both"
                    ? "sessions.saveUsernameAndPassword"
                    : loginSavePrompt === "username"
                      ? "sessions.saveUsername"
                      : "sessions.savePassword",
                )}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}

      {credentialPrompt ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section aria-modal="true" className="dialog credential-dialog" role="dialog">
            <header className="dialog-header">
              <KeyRound size={20} />
              <h2>{t("sessions.credentialRequired")}</h2>
            </header>
            <div className="credential-dialog-body">
              <label>
                <span>{t("sessions.credentialPassphrasePrompt")}</span>
                <TextInput
                  autoComplete="current-password"
                  autoFocus
                  disabled={credentialSubmitting}
                  onChange={(event) => setCredentialValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitCredential();
                    }
                  }}
                  type="password"
                  value={credentialValue}
                />
              </label>
              <label className="credential-remember-row">
                <input
                  checked={rememberCredential}
                  disabled={credentialSubmitting}
                  onChange={(event) => setRememberCredential(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("sessions.rememberCredential")}</span>
              </label>
              {!rememberCredential ? (
                <small>{t("sessions.credentialUseOnceHint")}</small>
              ) : null}
            </div>
            {dialogError ? <div className="form-error">{dialogError}</div> : null}
            <footer className="dialog-actions">
              <Button
                disabled={credentialSubmitting}
                onClick={closeCredentialPrompt}
                variant="ghost"
              >
                {t("sessions.cancel")}
              </Button>
              <Button
                disabled={credentialSubmitting}
                icon={<Link aria-hidden="true" size={16} />}
                onClick={() => void submitCredential()}
                variant="primary"
              >
                {rememberCredential ? t("sessions.saveAndConnect") : t("sessions.connect")}
              </Button>
            </footer>
          </section>
        </div>
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
              <Button
                onClick={() => {
                  setHostKeyChallenge(null);
                  clearTemporaryLogin();
                  reportState("disconnected");
                }}
                variant="ghost"
              >
                {t("sessions.cancel")}
              </Button>
              <Button
                icon={<ShieldCheck aria-hidden="true" size={16} />}
                onClick={() => void trustAndReconnect()}
              >
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
              <Button onClick={() => setHostKeyChange(null)} variant="ghost">
                {t("sessions.close")}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}

    </div>
  );
});

function decodeBase64(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isValidRemotePath(path: string) {
  return (
    path.startsWith("/") &&
    new TextEncoder().encode(path).byteLength <= 4096 &&
    !hasControlCharacter(path)
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
