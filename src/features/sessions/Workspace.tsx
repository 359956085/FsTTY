import { Activity, Columns3, MoreHorizontal, Plus, Server, UserRound } from "lucide-react";
import type {
  DeviceStatus,
  FileEntry,
  Session,
  SessionConnection,
} from "../../shared/api/types";
import { FilesPane } from "./FilesPane";
import { TerminalPane } from "./TerminalPane";
import { DeviceStatusPanel } from "./DeviceStatusPanel";

interface WorkspaceProps {
  activeSessionId: string | null;
  connection: SessionConnection | null;
  deviceStatus: DeviceStatus | null;
  files: FileEntry[];
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
}

export function Workspace({
  activeSessionId,
  connection,
  deviceStatus,
  files,
  sessions,
  onSelectSession,
}: WorkspaceProps) {
  const activeSession = connection?.session ?? null;

  return (
    <div className="workspace-grid">
      <section className="terminal-panel">
        <div className="session-tabs">
          {sessions.slice(0, 4).map((session) => (
            <button
              className={activeSessionId === session.id ? "session-tab session-tab-active" : "session-tab"}
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              type="button"
            >
              <span className={`status-dot status-${session.status}`} />
              {session.name}
            </button>
          ))}
          <button className="session-tab session-tab-add" type="button">
            <Plus size={16} />
          </button>
        </div>

        {activeSession ? (
          <div className="terminal-header">
            <div className="terminal-host">
              <span className={`status-dot status-${activeSession.status}`} />
              <strong>{activeSession.name}</strong>
              <span>
                <Activity size={15} />
                {activeSession.host}
              </span>
              <span>
                <UserRound size={15} />
                {activeSession.username}
              </span>
              <span>
                <Server size={15} />
                {activeSession.os}
              </span>
            </div>
            <div className="terminal-tools">
              <Plus size={17} />
              <Columns3 size={17} />
              <MoreHorizontal size={17} />
            </div>
          </div>
        ) : null}

        <TerminalPane connection={connection} />
      </section>

      <aside className="right-rail">
        <FilesPane files={files} sessionName={activeSession?.name ?? "-"} />
        <DeviceStatusPanel status={deviceStatus} />
      </aside>
    </div>
  );
}

