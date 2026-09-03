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
  Session,
  SshConnection,
  ShortcutSettings,
  TerminalEvent,
  TerminalResumeEvent,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { TextInput } from "../../shared/ui/TextInput";
import { hasControlCharacter } from "../../shared/validation/text";
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
  readSystemClipboard,
  resolveTerminalClipboardShortcut,
  writeSystemClipboard,
} from "./terminalClipboard";
import {
  getTerminalTheme,
  installTerminalRuntime,
  type InstalledTerminalRuntime,
} from "./terminalRuntime";
import {
  syncTerminalActivity,
  type TerminalActivityController,
} from "./terminalActivity";
import { createTerminalConnectionLifecycle } from "./terminalConnectionLifecycle";
import { createTerminalResumeStream } from "./terminalResumeStream";
import {
  createTerminalInputController,
  type TerminalInputController,
} from "./terminalInputController";
import { CommandHistoryPopover } from "./CommandHistoryPopover";
import type { CommandHistoryPopoverHandle } from "./CommandHistoryPopover";
import { matchesShortcut } from "../../shared/shortcuts";
import type { ResolvedTheme } from "../../shared/theme";
import { createCommandHistoryInsertion } from "./terminalCommandHistory";
import { decodeBase64 } from "./terminalProtocol";
import {
  createTerminalShellIntegration,
  SHELL_OSC_IDENTIFIERS,
} from "./terminalShellIntegration";
import { useTerminalAuthDialogs } from "./useTerminalAuthDialogs";
import { createTerminalInteractionCoordinator } from "./terminalInteractionCoordinator";
import {
  getInitialLightweightModeState,
  hasPreservedTerminal,
  isLightweightTransitioning,
  markPreservedTerminalAttached,
  markPreservedTerminalFailed,
  registerLightweightTerminal,
} from "../lightweight/lightweightMode";

const CLIPBOARD_MESSAGE_KEYS = {
  nonText: "sessions.clipboardNonText",
  read: "sessions.clipboardReadFailed",
  write: "sessions.clipboardWriteFailed",
} as const;
type ClipboardMessageKind = keyof typeof CLIPBOARD_MESSAGE_KEYS;

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

interface LightweightBarrierWait {
  cancelled: boolean;
  promise: Promise<void>;
  resolve: () => void;
}

interface TerminalPaneProps {
  active: boolean;
  allowRemoteClipboardWrite: boolean;
  autoConnect: boolean;
  visible: boolean;
  runtimeId: string;
  session: Session;
  shortcuts: ShortcutSettings;
  theme: ResolvedTheme;
  connectionState: ConnectionState;
  currentPath?: string;
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
  currentPath = "/",
  onConnected,
  onCredentialSaved,
  onDirectoryChange,
  onStateChange,
  runtimeId,
  session,
  shortcuts,
  theme,
  visible,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<XTermFitAddon | null>(null);
  const connectionLifecycleRef = useRef(
    createTerminalConnectionLifecycle<
      SshConnection,
      Channel<TerminalEvent> | Channel<TerminalResumeEvent>
    >(),
  );
  const interactionCoordinatorRef = useRef(createTerminalInteractionCoordinator());
  const inputControllerRef = useRef<TerminalInputController | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const clipboardErrorTimerRef = useRef<number | null>(null);
  const imeCompositionFallbackRef = useRef<ReturnType<
    typeof createImeCompositionFallback
  > | null>(null);
  const remoteRightDragStateRef = useRef(createRemoteRightDragState());
  const remoteMouseActivityRef = useRef<TerminalActivityController | null>(null);
  const resizeObserverActivityRef = useRef<TerminalActivityController | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => undefined);
  const terminalLoginInputRef = useRef(createTerminalLoginInputController());
  const temporaryLoginRef = useRef<TemporaryLogin | null>(null);
  const handleTerminalLoginDataRef = useRef<(data: string) => boolean>(() => false);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(session.id);
  const currentPathRef = useRef(currentPath);
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  const onCredentialSavedRef = useRef(onCredentialSaved);
  const shellIntegrationRef = useRef<ReturnType<
    typeof createTerminalShellIntegration
  > | null>(null);
  const autoConnectRef = useRef(autoConnect);
  const connectTerminalRef = useRef<(options?: ConnectTerminalOptions) => Promise<void>>(
    async () => undefined,
  );
  const handleShellOscRef = useRef<
    (identifier: 7 | 133 | 633 | 777, data: string) => boolean
  >(() => true);
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
  const shortcutsRef = useRef(shortcuts);
  const themeRef = useRef(theme);
  const lightweightBlockedRef = useRef(false);
  const lightweightBarrierRef = useRef<LightweightBarrierWait | null>(null);
  const restoringRef = useRef(false);
  const resumeStreamRef = useRef<ReturnType<typeof createTerminalResumeStream> | null>(null);
  shortcutsRef.current = shortcuts;
  themeRef.current = theme;
  sessionIdRef.current = session.id;
  currentPathRef.current = currentPath;
  const commandHistoryRef = useRef<CommandHistoryPopoverHandle | null>(null);
  const {
    credentialPrompt,
    credentialSubmitting,
    credentialValue,
    dialogError,
    hostKeyChallenge,
    hostKeyChange,
    loginSaveError,
    loginSavePrompt,
    loginSaveSubmitting,
    rememberCredential,
    setCredentialPrompt,
    setCredentialSubmitting,
    setCredentialValue,
    setDialogError,
    setHostKeyChallenge,
    setHostKeyChange,
    setLoginSaveError,
    setLoginSavePrompt,
    setLoginSaveSubmitting,
    setRememberCredential,
    setTerminalLoginPrompt,
    terminalLoginPrompt,
  } = useTerminalAuthDialogs();
  const hostKeyChallengeRef = useRef(hostKeyChallenge);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboardError, setClipboardError] = useState<ClipboardMessageKind | null>(null);
  lightweightBlockedRef.current =
    connectionState === "connecting" ||
    Boolean(
      credentialPrompt ||
        hostKeyChallenge ||
        hostKeyChange ||
        loginSavePrompt ||
        terminalLoginPrompt,
    );

  shellIntegrationRef.current ??= createTerminalShellIntegration({
    addHistory: (command) => api.addCommandHistory(command),
    onDirectoryChange: (path) => onDirectoryChangeRef.current(runtimeId, path),
    onHistoryError: (error) => {
      // 历史库故障不能阻塞远程终端；后续命令仍可自动恢复写入。
      console.error("历史命令保存失败", error);
    },
    send: (data) => sendImmediateInputRef.current(data),
  });

  onDirectoryChangeRef.current = onDirectoryChange;
  onCredentialSavedRef.current = onCredentialSaved;
  hostKeyChallengeRef.current = hostKeyChallenge;
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

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.theme = getTerminalTheme(theme);
    }
  }, [theme]);

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

  function createInputController() {
    return createTerminalInputController({
      getConnectionId: () =>
        connectionLifecycleRef.current.connection()?.connectionId ?? null,
      isConnecting: () => connectionLifecycleRef.current.isConnecting(),
      onWriteError: (connectionId, error) => {
        if (connectionLifecycleRef.current.connection()?.connectionId !== connectionId) return;
        connectionLifecycleRef.current.reset();
        void api.disconnectSession(connectionId).catch(() => undefined);
        reportStateRef.current(
          "error",
          resolveApiError(error, translateRef.current("errors.unknown")),
        );
      },
      write: (connectionId, data) => api.writeTerminal(connectionId, data),
    });
  }

  function clearPendingInput() {
    inputControllerRef.current?.clear();
  }

  function resetShellIntegration() {
    shellIntegrationRef.current?.reset();
  }

  function handleShellOsc(identifier: 7 | 133 | 633 | 777, data: string) {
    return shellIntegrationRef.current?.handleOsc(identifier, data) ?? true;
  }

  function flushInput() {
    inputControllerRef.current?.flush();
  }

  function sendImmediateInput(data: string) {
    sendInputRef.current(data);
    flushInput();
  }

  function fitAndResize() {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (
      isLightweightTransitioning() ||
      restoringRef.current ||
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
    const connection = connectionLifecycleRef.current.connection();
    if (!connection || terminal.cols < 1 || terminal.rows < 1) {
      return;
    }
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const currentConnection = connectionLifecycleRef.current.connection();
      if (
        currentConnection && activeRef.current && visibleRef.current &&
        !isLightweightTransitioning() && !restoringRef.current
      ) {
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
    // StrictMode 会重放 Effect；每次安装必须拥有独立控制器，不能复用上次清理时已销毁的实例。
    const connectionLifecycle = createTerminalConnectionLifecycle<
      SshConnection,
      Channel<TerminalEvent> | Channel<TerminalResumeEvent>
    >();
    const interactionCoordinator = createTerminalInteractionCoordinator();
    connectionLifecycleRef.current = connectionLifecycle;
    interactionCoordinatorRef.current = interactionCoordinator;
    const inputController = createInputController();
    inputControllerRef.current = inputController;
    sendInputRef.current = inputController.enqueue;
    let observer: ResizeObserver | null = null;
    let oscHandlers: { dispose(): void }[] = [];
    let runtimeInstance: InstalledTerminalRuntime | null = null;
    let disposeImeListeners: (() => void) | null = null;
    let remoteMouseListenersAttached = false;
    let resizeObserverActive = false;
    let unregisterLightweightTerminal: (() => void) | null = null;
    const terminalLoginInput = terminalLoginInputRef.current;

    async function mountTerminal() {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const runtime = await installTerminalRuntime({
        container,
        isActive: () => activeRef.current,
        isCancelled: () => disposed,
        isRemoteClipboardAllowed: () =>
          allowRemoteClipboardWriteRef.current &&
          activeRef.current &&
          visibleRef.current,
        isVisible: () => visibleRef.current,
        onClipboardWriteError: () => reportClipboardErrorRef.current(),
        theme: themeRef.current,
      });
      if (!runtime) {
        return;
      }
      runtimeInstance = runtime;
      const { fitAddon, terminal } = runtime;
      // 动态模块加载期间主题可能已变化，安装完成时再次对齐最新值。
      terminal.options.theme = getTerminalTheme(themeRef.current);
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
          connectionLifecycleRef.current.connection() !== null &&
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
        if (event.type !== "keydown" || !activeRef.current || !visibleRef.current) {
          return true;
        }
        const currentShortcuts = shortcutsRef.current;
        if (matchesShortcut(event, currentShortcuts.commandHistory)) {
          event.preventDefault();
          event.stopPropagation();
          commandHistoryRef.current?.toggle();
          return false;
        }
        if (matchesShortcut(event, currentShortcuts.commandHistorySearch)) {
          event.preventDefault();
          event.stopPropagation();
          commandHistoryRef.current?.focusSearch();
          return false;
        }
        const action = resolveTerminalClipboardShortcut(
          event,
          terminal.hasSelection(),
          currentShortcuts,
        );
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
      oscHandlers = SHELL_OSC_IDENTIFIERS.map((identifier) =>
        terminal.parser.registerOscHandler(identifier, (data) =>
          handleShellOscRef.current(identifier, data),
        ),
      );
      terminal.onData((data) => {
        if (handleTerminalLoginDataRef.current(data)) {
          return;
        }
        sendInputRef.current(data);
      });
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      unregisterLightweightTerminal = registerLightweightTerminal(runtimeId, {
        cancelPreparation: cancelLightweightPreparation,
        capture: () => captureLightweightSnapshot(runtime),
        describe: () => {
          const connection = connectionLifecycleRef.current.connection();
          if (!connection) {
            return null;
          }
          return {
            runtimeId,
            connection,
            currentPath: currentPathRef.current,
            columns: Math.max(1, terminal.cols),
            rows: Math.max(1, terminal.rows),
            shellIntegrationToken: shellIntegrationRef.current?.snapshotToken(),
          };
        },
        isBlocked: () =>
          lightweightBlockedRef.current || restoringRef.current ||
          connectionLifecycleRef.current.isConnecting(),
        prepareBarrier: prepareLightweightBarrier,
      });
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
      const restored = await restorePreservedTerminal(runtime);
      if (!restored && autoConnectRef.current && !disposed) {
        void connectTerminalRef.current();
      }
    }

    void mountTerminal().catch(() => {
      if (!disposed) {
        markPreservedTerminalFailed(runtimeId);
        reportStateRef.current("error", translateRef.current("sessions.terminalNotReady"));
      }
    });
    return () => {
      disposed = true;
      resizeObserverActivityRef.current?.stop();
      resizeObserverActivityRef.current = null;
      oscHandlers.forEach((handler) => handler.dispose());
      oscHandlers = [];
      inputController.dispose();
      if (inputControllerRef.current === inputController) {
        inputControllerRef.current = null;
        sendInputRef.current = () => undefined;
      }
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
      unregisterLightweightTerminal?.();
      unregisterLightweightTerminal = null;
      cancelLightweightPreparation();
      resumeStreamRef.current?.dispose();
      resumeStreamRef.current = null;
      restoringRef.current = false;
      const wasConnecting = connectionLifecycle.isConnecting();
      const connection = connectionLifecycle.dispose();
      interactionCoordinator.dispose();
      if (connection && !isLightweightTransitioning()) {
        void api.disconnectSession(connection.connectionId).catch(() => undefined);
      } else if (wasConnecting && !isLightweightTransitioning()) {
        // 卸载发生在后端返回连接 ID 前，使用会话 ID 取消连接尝试，避免迟到注册。
        void api.disconnectSession(sessionIdRef.current).catch(() => undefined);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
      runtimeInstance?.dispose();
    };
    // 终端运行时只安装一次；恢复函数与运行时 ID 均按组件实例固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // 终端运行时刻意通过 ref 读取函数，避免可见性变化重建连接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connectionState, visible]);

  async function connectTerminal(options: ConnectTerminalOptions = {}) {
    const { fromCredentialPrompt = false, oneTimeCredential } = options;
    if (
      isLightweightTransitioning() ||
      restoringRef.current ||
      connectionState === "connecting" ||
      !connectionLifecycleRef.current.canConnect()
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
    const attemptId = connectionLifecycleRef.current.beginConnect();
    if (attemptId === null) {
      return;
    }
    setDialogError(null);
    setHostKeyChange(null);
    reportState("connecting");
    const isCurrentAttempt = () =>
      mountedRef.current && connectionLifecycleRef.current.isCurrent(attemptId);
    const canRetryAttempt = () => isCurrentAttempt() && activeRef.current;
    const runConnectAttempt = () => {
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = (event) => {
        if (
          !isCurrentAttempt() ||
          !connectionLifecycleRef.current.acceptsEvent(
            attemptId,
            channel,
            event.connectionId,
          )
        ) {
          return;
        }
        if (event.kind === "data") {
          if (consumeLightweightBarrier(event.data)) {
            return;
          }
          terminalRef.current?.write(decodeBase64(event.data));
          return;
        }
        if (event.kind === "error") {
          connectionLifecycleRef.current.reset();
          clearPendingInput();
          resetShellIntegration();
          clearTemporaryLogin();
          terminalRef.current?.writeln(`\r\n[FsTTY] ${event.message}`);
          reportState("error", event.message);
          return;
        }
        connectionLifecycleRef.current.reset();
        clearPendingInput();
        resetShellIntegration();
        clearTemporaryLogin();
        terminalRef.current?.writeln(`\r\n[FsTTY] ${event.message}`);
        reportState("disconnected");
      };
      connectionLifecycleRef.current.attachChannel(attemptId, channel);
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
        connectionLifecycleRef.current.clearChannel();
        clearPendingInput();
        resetShellIntegration();
        reportState("disconnected");
        return;
      }
      if (!mountedRef.current || !connectionLifecycleRef.current.isCurrent(attemptId)) {
        if (result.kind === "connected") {
          await api
            .disconnectSession(result.connection.connectionId)
            .catch(() => undefined);
        }
        return;
      }
      if (result.kind === "hostKeyRequired") {
        connectionLifecycleRef.current.clearChannel();
        clearPendingInput();
        setHostKeyChallenge(result.challenge);
        reportState("disconnected");
        return;
      }
      if (result.kind === "hostKeyChanged") {
        connectionLifecycleRef.current.clearChannel();
        clearPendingInput();
        setHostKeyChange(result.change);
        clearTemporaryLogin();
        reportState("error", t("sessions.hostKeyChanged"));
        return;
      }
      if (result.kind === "credentialRequired") {
        connectionLifecycleRef.current.clearChannel();
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
      if (!connectionLifecycleRef.current.setConnection(attemptId, result.connection)) {
        await api.disconnectSession(result.connection.connectionId).catch(() => undefined);
        return;
      }
      setCredentialPrompt(null);
      setCredentialValue("");
      setDialogError(null);
      flushInput();
      onConnected(runtimeId, result.connection);
      shellIntegrationRef.current?.activate(result.connection.shellName);
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
      fitAndResize();
    } catch (error) {
      if (!mountedRef.current || !connectionLifecycleRef.current.isCurrent(attemptId)) {
        return;
      }
      connectionLifecycleRef.current.clearChannel();
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
      connectionLifecycleRef.current.finishConnect(attemptId);
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
    const generation = interactionCoordinatorRef.current.begin("credential");
    if (generation === null) return;
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
      if (interactionCoordinatorRef.current.isCurrent("credential", generation)) {
        setDialogError(resolveApiError(error, t("errors.unknown")));
      }
    } finally {
      if (interactionCoordinatorRef.current.finish("credential", generation)) {
        setCredentialSubmitting(false);
      }
    }
  }

  function prepareLightweightBarrier() {
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    lightweightBarrierRef.current = { cancelled: false, promise, resolve };
  }

  function consumeLightweightBarrier(data: string) {
    const barrier = lightweightBarrierRef.current;
    if (data !== "" || !barrier) {
      return false;
    }
    barrier.resolve();
    return true;
  }

  function cancelLightweightPreparation() {
    const barrier = lightweightBarrierRef.current;
    if (!barrier) {
      return;
    }
    barrier.cancelled = true;
    barrier.resolve();
    lightweightBarrierRef.current = null;
  }

  async function captureLightweightSnapshot(runtime: InstalledTerminalRuntime) {
    const barrier = lightweightBarrierRef.current;
    if (!barrier) {
      throw new Error("终端快照屏障未建立");
    }
    let timer: number | null = null;
    try {
      return await Promise.race([
        (async () => {
          await barrier.promise;
          if (barrier.cancelled) throw new Error("终端快照已取消");
          // 写队列排空也受同一超时约束，避免失效 WebView 永久卡住切换按钮。
          await new Promise<void>((resolve) => runtime.terminal.write("", resolve));
          if (barrier.cancelled || terminalRef.current !== runtime.terminal) {
            throw new Error("终端快照已取消");
          }
          return {
            full: runtime.serializeAddon.serialize({ scrollback: 10_000 }),
            viewport: runtime.serializeAddon.serialize({ scrollback: 0 }),
          };
        })(),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("等待终端快照屏障超时")), 55_000);
        }),
      ]);
    } finally {
      barrier.cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      if (lightweightBarrierRef.current === barrier) {
        lightweightBarrierRef.current = null;
      }
    }
  }

  async function restorePreservedTerminal(runtime: InstalledTerminalRuntime) {
    if (!hasPreservedTerminal(runtimeId)) {
      return false;
    }
    const preserved = getInitialLightweightModeState().terminals.find(
      (terminal) => terminal.runtimeId === runtimeId,
    );
    if (!preserved) return false;
    const lifecycle = connectionLifecycleRef.current;
    const attemptId = lifecycle.beginConnect();
    if (attemptId === null) return true;
    const isCurrent = () =>
      mountedRef.current && terminalRef.current === runtime.terminal &&
      connectionLifecycleRef.current === lifecycle && lifecycle.isCurrent(attemptId);
    restoringRef.current = true;
    reportStateRef.current("connecting");
    const channel = new Channel<TerminalResumeEvent>();
    lifecycle.attachChannel(attemptId, channel);
    const stream = createTerminalResumeStream({
      connectionId: preserved.connectionId,
      isCurrent,
      write: (data, callback) => runtime.terminal.write(data, callback),
      consumeBarrier: consumeLightweightBarrier,
      onEnd: (event) => {
        markPreservedTerminalAttached(runtimeId);
        lifecycle.reset();
        restoringRef.current = false;
        clearPendingInput();
        resetShellIntegration();
        runtime.terminal.writeln(`\r\n[FsTTY] ${event.message}`);
        reportStateRef.current(event.kind === "error" ? "error" : "disconnected", event.message);
      },
    });
    resumeStreamRef.current = stream;
    channel.onmessage = stream.push;
    let restoreTimer: number | null = null;
    try {
      const result = await Promise.race([
        (async () => {
          const attachment = await api.attachPreservedTerminal(runtimeId, channel);
          if (!isCurrent()) {
            if (!isLightweightTransitioning()) {
              await api.disconnectSession(attachment.connection.connectionId).catch(() => undefined);
            }
            return null;
          }
          if (
            attachment.runtimeId !== runtimeId ||
            attachment.connection.connectionId !== preserved.connectionId ||
            attachment.connection.sessionId !== session.id
          ) {
            throw new Error("终端恢复状态已失效");
          }
          runtime.terminal.reset();
          runtime.terminal.resize(attachment.columns, attachment.rows);
          lifecycle.setConnection(attemptId, attachment.connection);
          shellIntegrationRef.current?.restore(attachment.shellIntegrationToken);
          onDirectoryChangeRef.current(runtimeId, attachment.currentPath);
          onConnected(runtimeId, attachment.connection);
          stream.start();
          return { attachment, truncated: await stream.ready };
        })(),
        new Promise<never>((_, reject) => {
          restoreTimer = window.setTimeout(() => reject(new Error("终端恢复超时")), 30_000);
        }),
      ]);
      if (!result || !isCurrent()) return true;
      const { attachment, truncated } = result;
      markPreservedTerminalAttached(runtimeId);
      restoringRef.current = false;
      flushInput();
      const oldColumns = attachment.columns;
      const oldRows = attachment.rows;
      fitAndResize();
      const finalColumns = runtime.terminal.cols;
      const finalRows = runtime.terminal.rows;
      if (truncated && finalColumns === oldColumns && finalRows === oldRows) {
        const temporaryColumns = finalColumns > 1 ? finalColumns - 1 : finalColumns + 1;
        await api
          .resizeTerminal(attachment.connection.connectionId, temporaryColumns, finalRows)
          .catch(() => undefined);
        if (isCurrent()) {
          await api.resizeTerminal(attachment.connection.connectionId, finalColumns, finalRows)
            .catch(() => undefined);
        }
      }
      return true;
    } catch (error) {
      if (isCurrent()) {
        lifecycle.reset();
        markPreservedTerminalFailed(runtimeId);
        stream.dispose();
        clearPendingInput();
        resetShellIntegration();
        void api.disconnectSession(preserved.connectionId).catch(() => undefined);
        reportStateRef.current(
          "error",
          resolveApiError(error, translateRef.current("errors.unknown")),
        );
      }
      return true;
    } finally {
      if (restoreTimer !== null) window.clearTimeout(restoreTimer);
      if (connectionLifecycleRef.current === lifecycle) restoringRef.current = false;
      lifecycle.finishConnect(attemptId);
    }
  }

  function closeCredentialPrompt() {
    interactionCoordinatorRef.current.cancel("credential");
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
    const generation = interactionCoordinatorRef.current.begin("loginSave");
    if (generation === null) return;
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
      if (interactionCoordinatorRef.current.isCurrent("loginSave", generation)) {
        clearTemporaryLogin();
        restoreTerminalFocus();
      }
    } catch (error) {
      if (interactionCoordinatorRef.current.isCurrent("loginSave", generation)) {
        setLoginSaveError(resolveApiError(error, t("errors.unknown")));
      }
    } finally {
      if (interactionCoordinatorRef.current.finish("loginSave", generation)) {
        setLoginSaveSubmitting(false);
      }
    }
  }

  async function disconnectTerminal() {
    const connection = connectionLifecycleRef.current.connection();
    if (!connection) {
      if (connectionLifecycleRef.current.isConnecting()) {
        // 连接尚未返回 ID 时先使前端尝试失效，再用会话 ID 取消后端尝试，避免迟到注册。
        connectionLifecycleRef.current.cancel();
        await api.disconnectSession(sessionIdRef.current).catch(() => undefined);
      }
      reportState("disconnected");
      return;
    }
    const generation = interactionCoordinatorRef.current.begin("disconnect");
    if (generation === null) return;
    clearPendingInput();
    resetShellIntegration();
    reportState("disconnecting");
    try {
      await api.disconnectSession(connection.connectionId);
      if (
        !interactionCoordinatorRef.current.isCurrent("disconnect", generation) ||
        connectionLifecycleRef.current.connection()?.connectionId !== connection.connectionId
      ) {
        return;
      }
      connectionLifecycleRef.current.reset();
      clearPendingInput();
      resetShellIntegration();
      clearTemporaryLogin();
      reportState("disconnected");
    } catch (error) {
      if (interactionCoordinatorRef.current.isCurrent("disconnect", generation)) {
        reportState("error", resolveApiError(error, t("errors.unknown")));
      }
    } finally {
      interactionCoordinatorRef.current.finish("disconnect", generation);
    }
  }

  async function trustAndReconnect() {
    if (!hostKeyChallenge) {
      return;
    }
    const challengeId = hostKeyChallenge.challengeId;
    const generation = interactionCoordinatorRef.current.begin("trustHost");
    if (generation === null) return;
    try {
      await api.trustHostKey(session.id, challengeId);
      if (
        !interactionCoordinatorRef.current.isCurrent("trustHost", generation) ||
        hostKeyChallengeRef.current?.challengeId !== challengeId
      ) {
        return;
      }
      setHostKeyChallenge(null);
      await connectTerminal();
    } catch (error) {
      if (interactionCoordinatorRef.current.isCurrent("trustHost", generation)) {
        setDialogError(resolveApiError(error, t("errors.unknown")));
      }
    } finally {
      interactionCoordinatorRef.current.finish("trustHost", generation);
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
          onTriggerClose={restoreTerminalFocus}
          ref={commandHistoryRef}
          shortcuts={shortcuts}
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
                  interactionCoordinatorRef.current.cancel("trustHost");
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
