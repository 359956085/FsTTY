import { ChevronLeft, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionState,
  FileEntry,
  Session,
  SshConnection,
} from "../../shared/api/types";
import { DeviceStatusPanel } from "./DeviceStatusPanel";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { FilesPane } from "./FilesPane";
import { TerminalPane } from "./TerminalPane";
import type { SessionRuntime } from "./useSessionConnections";

interface WorkspaceProps {
  activeSessionId: string | null;
  activeRuntime: SessionRuntime;
  connectionStates: Readonly<Record<string, ConnectionState>>;
  error: string | null;
  loading: boolean;
  openSessions: Session[];
  rightCollapsed: boolean;
  rightResizeHandle: ReactNode;
  runtimes: Readonly<Record<string, SessionRuntime>>;
  verticalResizeHandle: ReactNode;
  visible: boolean;
  onCancelTransfer: (sessionId: string) => void;
  onDismissTransfer: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onConnected: (sessionId: string, connection: SshConnection) => void;
  onCreateSession: () => void;
  onDirectoryChange: (sessionId: string, path: string) => void;
  onDownload: (sessionId: string, file: FileEntry) => void;
  onOpenPath: (sessionId: string, path: string) => void;
  onRefreshFiles: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onTerminalState: (
    sessionId: string,
    state: ConnectionState,
    error?: string | null,
  ) => void;
  onToggleRight: () => void;
  onUpload: (sessionId: string) => void;
}

export function Workspace({
  activeRuntime,
  activeSessionId,
  connectionStates,
  error,
  loading,
  onCancelTransfer,
  onDismissTransfer,
  onCloseSession,
  onConnected,
  onCreateSession,
  onDirectoryChange,
  onDownload,
  onOpenPath,
  onRefreshFiles,
  onSelectSession,
  onTerminalState,
  onToggleRight,
  onUpload,
  openSessions,
  rightCollapsed,
  rightResizeHandle,
  runtimes,
  verticalResizeHandle,
  visible,
}: WorkspaceProps) {
  const { t } = useTranslation();
  const activeError = activeRuntime.error ?? error;
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  return (
    <section
      className={rightCollapsed ? "workspace-grid right-collapsed" : "workspace-grid"}
    >
      <div className="session-tabs" onContextMenu={(event) => event.preventDefault()}>
        {openSessions.map((session) => (
          <div
            className={
              activeSessionId === session.id
                ? "session-tab session-tab-active"
                : "session-tab"
            }
            key={session.id}
            onContextMenu={(event) => {
              event.preventDefault();
              setTabContextMenu({ x: event.clientX, y: event.clientY, sessionId: session.id });
            }}
          >
            <button onClick={() => onSelectSession(session.id)} type="button">
              <span
                className={`status-dot status-${
                  connectionStates[session.id] === "connected" ? "online" : "offline"
                }`}
              />
              <span>{session.name}</span>
            </button>
            <button
              aria-label={`${t("sessions.closeTab")} ${session.name}`}
              className="session-tab-close"
              onClick={() => onCloseSession(session.id)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          aria-label={t("sessions.new")}
          className="session-tab-add"
          onClick={onCreateSession}
          type="button"
        >
          <Plus size={20} />
        </button>
      </div>

      {tabContextMenu ? (
        <ContextMenu
          items={[
            { id: "close", label: t("sessions.contextCloseCurrent"), icon: <X size={15} />, onSelect: () => onCloseSession(tabContextMenu.sessionId) },
            { id: "closeOthers", label: t("sessions.contextCloseOthers"), onSelect: () => openSessions.filter((session) => session.id !== tabContextMenu.sessionId).forEach((session) => onCloseSession(session.id)) },
            { id: "closeAll", label: t("sessions.contextCloseAll"), danger: true, onSelect: () => openSessions.forEach((session) => onCloseSession(session.id)) },
          ]}
          onClose={() => setTabContextMenu(null)}
          x={tabContextMenu.x}
          y={tabContextMenu.y}
        />
      ) : null}

      <section className="terminal-panel">
        <div className="terminal-stage">
          {activeError ? (
            <div className="workspace-notice error-banner">{activeError}</div>
          ) : null}
          {loading ? (
            <div className="workspace-notice loading-banner">{t("sessions.loading")}</div>
          ) : null}
          {openSessions.map((session) => {
            const runtime = runtimes[session.id];
            return (
              <div
                className={
                  activeSessionId === session.id
                    ? "terminal-session terminal-session-active"
                    : "terminal-session"
                }
                key={session.id}
              >
                <TerminalPane
                  active={activeSessionId === session.id}
                  connectionState={runtime?.connectionState ?? "disconnected"}
                  directoryRequest={runtime?.terminalDirectoryRequest ?? null}
                  onConnected={onConnected}
                  onDirectoryChange={onDirectoryChange}
                  onStateChange={onTerminalState}
                  session={session}
                  visible={visible}
                />
              </div>
            );
          })}
          {openSessions.length === 0 ? (
            <div className="workspace-empty">{t("sessions.noSession")}</div>
          ) : null}
        </div>
      </section>

      {rightResizeHandle}

      {rightCollapsed ? (
        <aside className="collapsed-rail collapsed-rail-right">
          <button aria-label={t("sessions.expand")} onClick={onToggleRight} type="button">
            <ChevronLeft size={20} />
          </button>
        </aside>
      ) : (
        <aside className="right-rail">
          <FilesPane
            currentPath={activeRuntime.currentPath}
            files={activeRuntime.files}
            loading={activeRuntime.filesLoading}
            onCancelTransfer={() =>
              activeSessionId && onCancelTransfer(activeSessionId)
            }
            onDismissTransfer={() =>
              activeSessionId && onDismissTransfer(activeSessionId)
            }
            onCollapse={onToggleRight}
            onDownload={(file) =>
              activeSessionId && onDownload(activeSessionId, file)
            }
            onOpenPath={(path) =>
              activeSessionId && onOpenPath(activeSessionId, path)
            }
            onRefresh={() =>
              activeSessionId && onRefreshFiles(activeSessionId)
            }
            onUpload={() => activeSessionId && onUpload(activeSessionId)}
            sftpAvailable={Boolean(activeRuntime.connection?.sftpAvailable)}
            transfer={activeRuntime.transfer}
          />
          {verticalResizeHandle}
          <DeviceStatusPanel
            connected={activeRuntime.connectionState === "connected"}
            status={activeRuntime.deviceStatus}
          />
        </aside>
      )}
    </section>
  );
}
