import { ChevronLeft, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceStatus,
  FileEntry,
  Session,
  SessionConnection,
} from "../../shared/api/types";
import { DeviceStatusPanel } from "./DeviceStatusPanel";
import { FilesPane } from "./FilesPane";
import { TerminalPane } from "./TerminalPane";

interface WorkspaceProps {
  activeSessionId: string | null;
  connection: SessionConnection | null;
  currentPath: string;
  deviceStatus: DeviceStatus | null;
  error: string | null;
  files: FileEntry[];
  filesLoading: boolean;
  loading: boolean;
  openSessions: Session[];
  rightCollapsed: boolean;
  rightResizeHandle: ReactNode;
  verticalResizeHandle: ReactNode;
  onCloseSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onOpenPath: (path: string) => void;
  onRefreshFiles: () => void;
  onSelectSession: (sessionId: string) => void;
  onToggleRight: () => void;
}

export function Workspace({
  activeSessionId,
  connection,
  currentPath,
  deviceStatus,
  error,
  files,
  filesLoading,
  loading,
  onCloseSession,
  onCreateSession,
  onOpenPath,
  onRefreshFiles,
  onSelectSession,
  onToggleRight,
  openSessions,
  rightCollapsed,
  rightResizeHandle,
  verticalResizeHandle,
}: WorkspaceProps) {
  const { t } = useTranslation();

  return (
    <section className={rightCollapsed ? "workspace-grid right-collapsed" : "workspace-grid"}>
      <div className="session-tabs">
        {openSessions.map((session) => (
          <div
            className={
              activeSessionId === session.id
                ? "session-tab session-tab-active"
                : "session-tab"
            }
            key={session.id}
          >
            <button onClick={() => onSelectSession(session.id)} type="button">
              <span className={`status-dot status-${session.status}`} />
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

      <section className="terminal-panel">
        <div className="terminal-stage">
          {error ? <div className="workspace-notice error-banner">{error}</div> : null}
          {loading ? (
            <div className="workspace-notice loading-banner">{t("sessions.loading")}</div>
          ) : null}
          <TerminalPane connection={connection} />
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
            currentPath={currentPath}
            files={files}
            loading={filesLoading}
            onCollapse={onToggleRight}
            onOpenPath={onOpenPath}
            onRefresh={onRefreshFiles}
          />
          {verticalResizeHandle}
          <DeviceStatusPanel status={deviceStatus} />
        </aside>
      )}
    </section>
  );
}
