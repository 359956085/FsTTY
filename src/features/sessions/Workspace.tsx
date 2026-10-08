import { TooltipButton } from "../../shared/ui/TooltipButton";
import { ChevronLeft, Plus, X } from "lucide-react";
import type { MouseEventHandler, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionState,
  FileEntry,
  SshConnection,
  ShortcutSettings,
  TerminalColorScheme,
} from "../../shared/api/types";
import { DeviceStatusPanel } from "./DeviceStatusPanel";
import { isLocalSession } from "../../shared/api/types";
import { LocalTabStatusIcon } from "./LocalTabStatusIcon";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { contextMenuPosition, isComposingKey, isContextMenuKey, isFocusAvailable } from "../../shared/ui/focus";
import { FilesPane } from "./FilesPane";
import { TerminalPane } from "./TerminalPane";
import type { SessionRuntime } from "./useSessionConnections";
import type { OpenSessionTab } from "./useSessionsPageState";
import type { ResolvedTheme } from "../../shared/theme";
import { getPreservedRuntimeIds } from "../lightweight/lightweightMode";
import type { RemoteEntryDeleteFailure } from "./sessionRemoteFiles";

const MemoizedFilesPane = memo(FilesPane);

interface WorkspaceProps {
  allowRemoteClipboardWrite: boolean;
  activeTabId: string | null;
  activeRuntime: SessionRuntime;
  connectionStates: Readonly<Record<string, ConnectionState>>;
  error: string | null;
  onRetryRestore?: () => void;
  loading: boolean;
  openTabs: OpenSessionTab[];
  rightCollapsed: boolean;
  hideRightPanel?: boolean;
  rightResizeHandle: ReactNode;
  shortcuts: ShortcutSettings;
  theme: ResolvedTheme;
  terminalColorScheme: TerminalColorScheme;
  runtimes: Readonly<Record<string, SessionRuntime>>;
  visible: boolean;
  onCancelTransfer: (tabId: string) => void;
  onDismissTransfer: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onConnected: (tabId: string, connection: SshConnection) => void;
  onCredentialSaved: () => Promise<void> | void;
  onCreateRemoteDirectory: (tabId: string, name: string) => Promise<void>;
  onCreateSession: MouseEventHandler<HTMLButtonElement>;
  createSessionButtonRef?: RefObject<HTMLButtonElement | null>;
  onDeleteRemoteEntry: (tabId: string, path: string) => Promise<void>;
  onDeleteRemoteEntries: (tabId: string, paths: string[]) => Promise<RemoteEntryDeleteFailure[]>;
  onDirectoryChange: (tabId: string, path: string) => void;
  onDownload: (tabId: string, file: FileEntry) => void;
  onDownloadFiles: (tabId: string, files: FileEntry[]) => void;
  onMoveRemoteEntry: (
    tabId: string,
    sourcePath: string,
    targetDirectory: string,
  ) => Promise<void>;
  onOpenPath: (tabId: string, path: string) => void;
  onRefreshFiles: (tabId: string) => void;
  onRenameRemoteEntry: (tabId: string, path: string, newName: string) => Promise<void>;
  onSelectTab: (tabId: string) => void;
  onTerminalState: (
    tabId: string,
    state: ConnectionState,
    error?: string | null,
  ) => void;
  onToggleRight: () => void;
  onUpload: (tabId: string) => void;
  onUploadFiles: (tabId: string, localPaths: string[]) => void;
}

export function Workspace({
  allowRemoteClipboardWrite,
  activeRuntime,
  activeTabId,
  connectionStates,
  error,
  onRetryRestore,
  loading,
  onCancelTransfer,
  onDismissTransfer,
  onCloseTab,
  onConnected,
  onCredentialSaved,
  onCreateRemoteDirectory,
  onCreateSession,
  createSessionButtonRef,
  onDeleteRemoteEntry,
  onDeleteRemoteEntries,
  onDirectoryChange,
  onDownload,
  onDownloadFiles,
  onMoveRemoteEntry,
  onOpenPath,
  onRefreshFiles,
  onRenameRemoteEntry,
  onSelectTab,
  onTerminalState,
  onToggleRight,
  onUpload,
  onUploadFiles,
  openTabs,
  rightCollapsed,
  hideRightPanel = false,
  rightResizeHandle,
  shortcuts,
  theme,
  terminalColorScheme,
  runtimes,
  visible,
}: WorkspaceProps) {
  const { t } = useTranslation();
  const rightToggleRef = useRef<HTMLButtonElement>(null);
  const localCreateRef = useRef<HTMLButtonElement>(null);
  const newSessionRef = createSessionButtonRef ?? localCreateRef;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabMenuAnchor = useRef<HTMLButtonElement | null>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const closingTabs = useRef<{ ids: Set<string>; owner: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    const request = closingTabs.current;
    if (!request) return;
    const active = document.activeElement;
    if (!visible || (active !== document.body && active !== request.owner)) {
      closingTabs.current = null;
      return;
    }
    if (openTabs.some((tab) => request.ids.has(tab.id))) return;
    closingTabs.current = null;
    const target = (activeTabId && tabRefs.current.get(activeTabId)) || newSessionRef.current;
    if (isFocusAvailable(target)) {
      menuReturnFocusRef.current = target;
      target.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    const cancel = (event: Event) => {
      if (closingTabs.current && event.target !== closingTabs.current.owner && event.target !== document.body) closingTabs.current = null;
      if (event.target !== menuReturnFocusRef.current) menuReturnFocusRef.current = null;
    };
    document.addEventListener("focusin", cancel);
    document.addEventListener("pointerdown", cancel, true);
    return () => {
      closingTabs.current = null;
      menuReturnFocusRef.current = null;
      document.removeEventListener("focusin", cancel);
      document.removeEventListener("pointerdown", cancel, true);
    };
  }, []);
  function closeTabs(ids: string[]) {
    closingTabs.current = { ids: new Set(ids), owner: tabMenuAnchor.current };
    ids.forEach(onCloseTab);
  }
  const focusRightToggle = useRef(false);
  useLayoutEffect(() => {
    if (focusRightToggle.current && visible) {
      rightToggleRef.current?.focus();
      focusRightToggle.current = false;
    }
  }, [rightCollapsed, visible]);
  const toggleRight = useCallback(() => {
    focusRightToggle.current = true;
    onToggleRight();
  }, [onToggleRight]);
  // 设备快照更新不改变文件面板输入；标签切换时重新绑定全部文件操作。
  const fileActions = useMemo(() => ({
    onCancelTransfer: () => activeTabId && onCancelTransfer(activeTabId),
    onDismissTransfer: () => activeTabId && onDismissTransfer(activeTabId),
    onCreateDirectory: (name: string) => activeTabId
      ? onCreateRemoteDirectory(activeTabId, name) : Promise.resolve(),
    onDeleteEntry: (path: string) => activeTabId
      ? onDeleteRemoteEntry(activeTabId, path) : Promise.resolve(),
    onDeleteEntries: (paths: string[]) => activeTabId
      ? onDeleteRemoteEntries(activeTabId, paths) : Promise.resolve([]),
    onDownload: (file: FileEntry) => activeTabId && onDownload(activeTabId, file),
    onDownloadFiles: (files: FileEntry[]) => activeTabId && onDownloadFiles(activeTabId, files),
    onMoveEntry: (sourcePath: string, targetDirectory: string) => activeTabId
      ? onMoveRemoteEntry(activeTabId, sourcePath, targetDirectory) : Promise.resolve(),
    onOpenPath: (path: string) => activeTabId && onOpenPath(activeTabId, path),
    onRefresh: () => activeTabId && onRefreshFiles(activeTabId),
    onRenameEntry: (path: string, newName: string) => activeTabId
      ? onRenameRemoteEntry(activeTabId, path, newName) : Promise.resolve(),
    onUpload: () => activeTabId && onUpload(activeTabId),
    onUploadFiles: (localPaths: string[]) => activeTabId && onUploadFiles(activeTabId, localPaths),
  }), [
    activeTabId, onCancelTransfer, onDismissTransfer, onCreateRemoteDirectory,
    onDeleteRemoteEntry, onDeleteRemoteEntries, onDownload, onDownloadFiles,
    onMoveRemoteEntry, onOpenPath, onRefreshFiles, onRenameRemoteEntry,
    onUpload, onUploadFiles,
  ]);
  const activeError = activeRuntime.error ?? error;
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const [initializedTerminalIds, setInitializedTerminalIds] = useState<ReadonlySet<string>>(
    () => {
      const ids = getPreservedRuntimeIds();
      if (activeTabId) {
        ids.add(activeTabId);
      }
      return ids;
    },
  );

  useEffect(() => {
    if (!activeTabId) {
      return;
    }
    setInitializedTerminalIds((current) => {
      if (current.has(activeTabId)) {
        return current;
      }
      const next = new Set(current);
      next.add(activeTabId);
      return next;
    });
  }, [activeTabId]);

  useEffect(() => {
    const validIds = new Set(openTabs.map((tab) => tab.id));
    setInitializedTerminalIds((current) => {
      if ([...current].every((id) => validIds.has(id))) {
        return current;
      }
      return new Set([...current].filter((id) => validIds.has(id)));
    });
  }, [openTabs]);

  return (
    <section
      className={rightCollapsed || hideRightPanel ? "workspace-grid right-collapsed" : "workspace-grid"}
    >
      <div className="session-tabs" onContextMenu={(event) => event.preventDefault()}>
        {openTabs.map((tab) => {
          const localSession = isLocalSession(tab.session) ? tab.session : null;
          const local = localSession !== null;
          const state = connectionStates[tab.id] ?? "disconnected";
          const administrator = runtimes[tab.id]?.connection?.local?.elevated ?? tab.runAsAdmin ?? localSession?.runAsAdmin ?? false;
          const statusKeys: Record<ConnectionState, string> = {
            disconnected: "tabStatus.notRunning", connecting: administrator ? "local.waitingAdmin" : "local.starting",
            connected: "local.running", disconnecting: "tabStatus.stopping", error: "tabStatus.failed",
          };
          const description = local ? `${t(administrator ? "local.admin" : "local.standard")} · ${t(statusKeys[state])}` : undefined;
          return (
          <div
            className={
              activeTabId === tab.id
                ? "session-tab session-tab-active"
                : "session-tab"
            }
            key={tab.id}
            onContextMenu={(event) => {
              event.preventDefault();
              const target = tabRefs.current.get(tab.id);
              if (!target) return;
              tabMenuAnchor.current = target;
              setTabContextMenu({ ...contextMenuPosition(target, event), tabId: tab.id });
            }}
            onKeyDown={(event) => {
              if (event.defaultPrevented || isComposingKey(event.nativeEvent) || !isContextMenuKey(event)) return;
              event.preventDefault();
              event.stopPropagation();
              const target = tabRefs.current.get(tab.id);
              if (!target) return;
              tabMenuAnchor.current = target;
              setTabContextMenu({ ...contextMenuPosition(target), tabId: tab.id });
            }}
          >
            <button aria-description={description} onClick={() => {
              menuReturnFocusRef.current = null;
              onSelectTab(tab.id);
            }} ref={(node) => {
              if (node) tabRefs.current.set(tab.id, node);
              else tabRefs.current.delete(tab.id);
            }} type="button">
              {local ? <LocalTabStatusIcon administrator={administrator} running={state === "connected"} description={description!} /> : <span
                className={`status-dot status-${
                  connectionStates[tab.id] === "connected" ? "online" : "offline"
                }`}
              />}
              <span className="session-tab-name">{tab.session.name}</span>
            </button>
            <button
              aria-label={`${t("sessions.closeTab")} ${tab.session.name}`}
              className="session-tab-close"
              onClick={() => onCloseTab(tab.id)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        ); })}
        <TooltipButton
          label={t("sessions.new")}
          buttonRef={newSessionRef}
          className="session-tab-add"
          onClick={onCreateSession}
          type="button"
        >
          <Plus size={20} />
        </TooltipButton>
      </div>

      {tabContextMenu ? (
        <ContextMenu
          items={[
            { id: "close", label: t("sessions.contextCloseCurrent"), icon: <X size={15} />, onSelect: () => closeTabs([tabContextMenu.tabId]) },
            { id: "closeOthers", label: t("sessions.contextCloseOthers"), onSelect: () => closeTabs(openTabs.filter((tab) => tab.id !== tabContextMenu.tabId).map((tab) => tab.id)) },
            { id: "closeAll", label: t("sessions.contextCloseAll"), danger: true, onSelect: () => closeTabs(openTabs.map((tab) => tab.id)) },
          ]}
          onClose={() => setTabContextMenu(null)}
          returnFocus={() => tabMenuAnchor.current}
          fallbackFocus={() => (activeTabId && tabRefs.current.get(activeTabId)) || newSessionRef.current}
          x={tabContextMenu.x}
          y={tabContextMenu.y}
        />
      ) : null}

      <section className="terminal-panel">
        <div className="terminal-stage">
          {activeError ? (
            <div className="workspace-notice error-banner">
              {activeError}
              {onRetryRestore ? (
                <button type="button" onClick={onRetryRestore}>{t("lightweight.retryRestore")}</button>
              ) : null}
            </div>
          ) : null}
          {loading ? (
            <div className="workspace-notice loading-banner">{t("sessions.loading")}</div>
          ) : null}
          {openTabs.map((tab) => {
            const runtime = runtimes[tab.id];
            const terminalInitialized =
              activeTabId === tab.id || initializedTerminalIds.has(tab.id);
            return (
              <div
                className={
                  activeTabId === tab.id
                    ? "terminal-session terminal-session-active"
                    : "terminal-session"
                }
                key={tab.id}
              >
                {terminalInitialized ? (
                  <TerminalPane
                    active={activeTabId === tab.id}
                    allowRemoteClipboardWrite={allowRemoteClipboardWrite}
                    autoConnect={tab.autoConnect}
                    connectionState={runtime?.connectionState ?? "disconnected"}
                    currentPath={runtime?.currentPath ?? "/"}
                    activationFocusTarget={menuReturnFocusRef}
                    onConnected={onConnected}
                    onCredentialSaved={onCredentialSaved}
                    onDirectoryChange={onDirectoryChange}
                    onStateChange={onTerminalState}
                    runtimeId={tab.id}
                    session={tab.session}
                    runAsAdmin={tab.runAsAdmin}
                    shortcuts={shortcuts}
                    theme={theme}
                    terminalColorScheme={terminalColorScheme}
                    visible={visible}
                  />
                ) : null}
              </div>
            );
          })}
          {openTabs.length === 0 ? (
            <div className="workspace-empty">{t("sessions.noSession")}</div>
          ) : null}
        </div>
        {rightCollapsed && !hideRightPanel && (
          <TooltipButton
            aria-expanded={false}
            buttonRef={rightToggleRef}
            className="terminal-expand-right"
            label={t("nav.expandFiles")}
            onClick={toggleRight}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={18} />
          </TooltipButton>
        )}
      </section>

      {!rightCollapsed && !hideRightPanel && rightResizeHandle}

      {!rightCollapsed && !hideRightPanel && (
        <aside className="right-rail">
          <MemoizedFilesPane
            {...fileActions}
            collapseButtonRef={rightToggleRef}
            connectionId={activeRuntime.connection?.connectionId ?? null}
            currentPath={activeRuntime.currentPath}
            files={activeRuntime.files}
            key={activeTabId ?? "no-session"}
            loading={activeRuntime.filesLoading}
            onCollapse={toggleRight}
            sftpAvailable={Boolean(activeRuntime.connection?.sftpAvailable)}
            transfer={activeRuntime.transfer}
          />
          <DeviceStatusPanel
            connected={activeRuntime.connectionState === "connected"}
            history={activeRuntime.deviceHistory}
            loading={activeRuntime.deviceLoading}
            status={activeRuntime.deviceStatus}
            windowEndMs={activeRuntime.deviceWindowEndMs}
          />
        </aside>
      )}
    </section>
  );
}
