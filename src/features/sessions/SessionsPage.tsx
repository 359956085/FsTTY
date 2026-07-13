import { Pencil, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/ui/Button";
import { SessionFormDialog } from "./SessionFormDialog";
import { SessionList } from "./SessionList";
import { Workspace } from "./Workspace";
import { useSessionsPageState } from "./useSessionsPageState";

export function SessionsPage() {
  const { t } = useTranslation();
  const {
    activeSession,
    activeSessionId,
    connection,
    deleteActiveSession,
    deviceStatus,
    dialogState,
    error,
    files,
    groups,
    loading,
    query,
    refreshActiveSession,
    saveSession,
    sessions,
    setActiveSessionId,
    setDialogState,
    setQuery,
  } = useSessionsPageState({
    confirmDeleteText: t("sessions.confirmDelete"),
    errorFallback: t("errors.unknown"),
  });

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
            <Button
              disabled={!activeSessionId || loading}
              icon={<RefreshCcw size={16} />}
              onClick={() => void refreshActiveSession()}
              variant="ghost"
            >
              {t("sessions.refresh")}
            </Button>
            <Button
              disabled={!activeSession}
              icon={<Pencil size={16} />}
              onClick={() =>
                activeSession && setDialogState({ mode: "edit", session: activeSession })
              }
              variant="ghost"
            >
              {t("sessions.edit")}
            </Button>
            <Button
              disabled={!activeSession}
              icon={<Trash2 size={16} />}
              onClick={() => void deleteActiveSession()}
              variant="danger"
            >
              {t("sessions.delete")}
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setDialogState({ mode: "create" })}>
              {t("sessions.new")}
            </Button>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}
        {loading ? <div className="loading-banner">{t("sessions.loading")}</div> : null}

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
          onSave={(payload) => void saveSession(payload)}
        />
      ) : null}
    </section>
  );
}
