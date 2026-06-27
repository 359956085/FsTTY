import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCcw, Trash2, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import type {
  CreateSessionPayload,
  DeviceStatus,
  FileEntry,
  Session,
  SessionConnection,
  SessionGroup,
  UpdateSessionPayload,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { SessionList } from "./SessionList";
import { SessionFormDialog } from "./SessionFormDialog";
import { Workspace } from "./Workspace";

type DialogState =
  | { mode: "create"; session?: undefined }
  | { mode: "edit"; session: Session }
  | null;

export function SessionsPage() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [query, setQuery] = useState("");
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);

  const sessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const loadSessions = useCallback(async () => {
    const nextGroups = await api.listSessions();
    setGroups(nextGroups);

    const firstSession = nextGroups.flatMap((group) => group.sessions)[0];
    setActiveSessionId((current) => current ?? firstSession?.id ?? null);
  }, []);

  const loadSessionData = useCallback(async (sessionId: string) => {
    const [nextConnection, nextFiles, nextDeviceStatus] = await Promise.all([
      api.openSession(sessionId),
      api.listRemoteFiles(sessionId, "/var/www/app"),
      api.getDeviceStatus(sessionId),
    ]);

    setConnection(nextConnection);
    setFiles(nextFiles);
    setDeviceStatus(nextDeviceStatus);
  }, []);

  useEffect(() => {
    loadSessions().catch((nextError: unknown) => {
      setError(resolveError(nextError, t("errors.unknown")));
    });
  }, [loadSessions, t]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    loadSessionData(activeSessionId).catch((nextError: unknown) => {
      setError(resolveError(nextError, t("errors.unknown")));
    });
  }, [activeSessionId, loadSessionData, t]);

  async function handleSave(payload: CreateSessionPayload | UpdateSessionPayload) {
    setError(null);

    if ("id" in payload) {
      const updated = await api.updateSession(payload);
      await loadSessions();
      setActiveSessionId(updated.id);
    } else {
      const created = await api.createSession(payload);
      await loadSessions();
      setActiveSessionId(created.id);
    }

    setDialogState(null);
  }

  async function handleDelete() {
    if (!activeSession || !window.confirm(t("sessions.confirmDelete"))) {
      return;
    }

    setError(null);
    await api.deleteSession(activeSession.id);
    setConnection(null);
    setFiles([]);
    setDeviceStatus(null);
    setActiveSessionId(null);
    await loadSessions();
  }

  return (
    <section className="sessions-page">
      <SessionList
        activeSessionId={activeSessionId}
        groups={groups}
        query={query}
        onQueryChange={setQuery}
        onSelect={setActiveSessionId}
        onCreate={() => setDialogState({ mode: "create" })}
      />

      <section className="session-content">
        <header className="workspace-toolbar">
          <div>
            <h1>{activeSession?.name ?? t("sessions.noSession")}</h1>
            {activeSession ? (
              <p>
                {activeSession.host} · {activeSession.username} · {activeSession.os}
              </p>
            ) : null}
          </div>
          <div className="toolbar-actions">
            <Button icon={<RefreshCcw size={16} />} onClick={() => activeSessionId && void loadSessionData(activeSessionId)} variant="ghost">
              {t("sessions.refresh")}
            </Button>
            <Button disabled={!activeSession} icon={<Pencil size={16} />} onClick={() => activeSession && setDialogState({ mode: "edit", session: activeSession })} variant="ghost">
              {t("sessions.edit")}
            </Button>
            <Button disabled={!activeSession} icon={<Trash2 size={16} />} onClick={() => void handleDelete()} variant="danger">
              {t("sessions.delete")}
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setDialogState({ mode: "create" })}>
              {t("sessions.new")}
            </Button>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <Workspace
          connection={connection}
          deviceStatus={deviceStatus}
          files={files}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
        />
      </section>

      {dialogState ? (
        <SessionFormDialog
          mode={dialogState.mode}
          session={dialogState.session}
          onClose={() => setDialogState(null)}
          onSave={(payload) =>
            handleSave(payload).catch((nextError: unknown) => {
              setError(resolveError(nextError, t("errors.unknown")));
            })
          }
        />
      ) : null}
    </section>
  );
}

function resolveError(error: unknown, fallback: string) {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: string }).message);
  }

  return fallback;
}

