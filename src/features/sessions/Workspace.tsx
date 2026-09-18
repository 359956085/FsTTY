import { TooltipButton } from "../../shared/ui/TooltipButton";
import { ChevronLeft, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionState,
  FileEntry,
  SshConnection,
  ShortcutSettings,
  TerminalColorScheme,
} from "../../shared/api/types";
import { DeviceStatusPanel } from "./DeviceStatusPanel";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { FilesPane } from "./FilesPane";
import { TerminalPane } from "./TerminalPane";
import type { SessionRuntime } from "./useSessionConnections";
import type { OpenSessionTab } from "./useSessionsPageState";
import type { ResolvedTheme } from "../../shared/theme";
import { getPreservedRuntimeIds } from "../lightweight/lightweightMode";
import type { RemoteEntryDeleteFailure } from "./sessionRemoteFiles";

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
  onCreateSession: () => void;
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
  rightResizeHandle,
  shortcuts,
  theme,
  terminalColorScheme,
  runtimes,
  visible,
}: WorkspaceProps) {
  const { t } = useTranslation();
  const rightToggleRef = useRef<HTMLButtonElement>(null);
  const focusRightToggle = useRef(false);
  useLayoutEffect(() => {
    if (focusRightToggle.current && visible) {
      rightToggleRef.current?.focus();
      focusRightToggle.current = false;
    }
  }, [rightCollapsed, visible]);
  function toggleRight() {
    focusRightToggle.current = true;
    onToggleRight();
  }
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
      className={rightCollapsed ? "workspace-grid right-collapsed" : "workspace-grid"}
    >
      <div className="session-tabs" onContextMenu={(event) => event.preventDefault()}>
        {openTabs.map((tab) => (
          <div
            className={
              activeTabId === tab.id
                ? "session-tab session-tab-active"
                : "session-tab"
            }
            key={tab.id}
            onContextMenu={(event) => {
              event.preventDefault();
              setTabContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
            }}
          >
            <button onClick={() => onSelectTab(tab.id)} type="button">
              <span
                className={`status-dot status-${
                  connectionStates[tab.id] === "connected" ? "online" : "offline"
                }`}
              />
              <span>{tab.session.name}</span>
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
        ))}
        <TooltipButton
          label={t("sessions.new")}
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
            { id: "close", label: t("sessions.contextCloseCurrent"), icon: <X size={15} />, onSelect: () => onCloseTab(tabContextMenu.tabId) },
            { id: "closeOthers", label: t("sessions.contextCloseOthers"), onSelect: () => openTabs.filter((tab) => tab.id !== tabContextMenu.tabId).forEach((tab) => onCloseTab(tab.id)) },
            { id: "closeAll", label: t("sessions.contextCloseAll"), danger: true, onSelect: () => openTabs.forEach((tab) => onCloseTab(tab.id)) },
          ]}
          onClose={() => setTabContextMenu(null)}
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
                    onConnected={onConnected}
                    onCredentialSaved={onCredentialSaved}
                    onDirectoryChange={onDirectoryChange}
                    onStateChange={onTerminalState}
                    runtimeId={tab.id}
                    session={tab.session}
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
        {rightCollapsed && (
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

      {!rightCollapsed && rightResizeHandle}

      {!rightCollapsed && (
        <aside className="right-rail">
          <FilesPane
            collapseButtonRef={rightToggleRef}
            currentPath={activeRuntime.currentPath}
            files={activeRuntime.files}
            key={activeTabId ?? "no-session"}
            loading={activeRuntime.filesLoading}
            onCancelTransfer={() =>
              activeTabId && onCancelTransfer(activeTabId)
            }
            onDismissTransfer={() =>
              activeTabId && onDismissTransfer(activeTabId)
            }
            onCollapse={toggleRight}
            onCreateDirectory={(name) =>
              activeTabId
                ? onCreateRemoteDirectory(activeTabId, name)
                : Promise.resolve()
            }
            onDeleteEntry={(path) =>
              activeTabId ? onDeleteRemoteEntry(activeTabId, path) : Promise.resolve()
            }
            onDeleteEntries={(paths) =>
              activeTabId ? onDeleteRemoteEntries(activeTabId, paths) : Promise.resolve([])
            }
            onDownload={(file) =>
              activeTabId && onDownload(activeTabId, file)
            }
            onDownloadFiles={(files) =>
              activeTabId && onDownloadFiles(activeTabId, files)
            }
            onMoveEntry={(sourcePath, targetDirectory) =>
              activeTabId
                ? onMoveRemoteEntry(activeTabId, sourcePath, targetDirectory)
                : Promise.resolve()
            }
            onOpenPath={(path) =>
              activeTabId && onOpenPath(activeTabId, path)
            }
            onRefresh={() =>
              activeTabId && onRefreshFiles(activeTabId)
            }
            onRenameEntry={(path, newName) =>
              activeTabId
                ? onRenameRemoteEntry(activeTabId, path, newName)
                : Promise.resolve()
            }
            onUpload={() => activeTabId && onUpload(activeTabId)}
            onUploadFiles={(localPaths) =>
              activeTabId && onUploadFiles(activeTabId, localPaths)
            }
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
