import { ChevronRight } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "./ResizeHandle";
import { SessionFormDialog } from "./SessionFormDialog";
import { SessionList } from "./SessionList";
import { usePaneLayout } from "./usePaneLayout";
import {
  createRuntime,
  useSessionConnections,
} from "./useSessionConnections";
import { useSessionsPageState } from "./useSessionsPageState";
import { Workspace } from "./Workspace";
import { WORKSPACE_LAYOUT_LIMITS } from "./workspacePreferences";

interface SessionsPageProps {
  visible: boolean;
}

export function SessionsPage({ visible }: SessionsPageProps) {
  const { t } = useTranslation();
  const sessionsState = useSessionsPageState({
    confirmDeleteText: t("sessions.confirmDelete"),
    errorFallback: t("errors.unknown"),
  });
  const connections = useSessionConnections({
    errorFallback: t("errors.unknown"),
  });
  const {
    adjustResize,
    beginResize,
    layout,
    rootRef,
    toggleLeftCollapsed,
    toggleRightCollapsed,
  } = usePaneLayout();
  const validSessionIds = useMemo(
    () => new Set(sessionsState.sessions.map((session) => session.id)),
    [sessionsState.sessions],
  );

  useEffect(() => {
    connections.pruneRuntimes(validSessionIds);
  }, [connections.pruneRuntimes, validSessionIds]);

  const connectionStates = useMemo(
    () =>
      Object.fromEntries(
        sessionsState.sessions.map((session) => [
          session.id,
          connections.runtimes[session.id]?.connectionState ?? "disconnected",
        ]),
      ),
    [connections.runtimes, sessionsState.sessions],
  );
  const activeRuntime = sessionsState.activeSessionId
    ? connections.runtimes[sessionsState.activeSessionId] ?? createRuntime()
    : createRuntime();

  async function closeSession(sessionId: string) {
    await connections.disconnect(sessionId);
    connections.removeRuntime(sessionId);
    sessionsState.closeSessionTab(sessionId);
  }

  async function deleteSession() {
    const deletedId = await sessionsState.deleteActiveSession();
    if (deletedId) {
      connections.removeRuntime(deletedId);
    }
  }

  return (
    <div
      className={
        layout.leftCollapsed ? "sessions-page left-collapsed" : "sessions-page"
      }
      ref={rootRef}
    >
      {layout.leftCollapsed ? (
        <aside className="collapsed-rail collapsed-rail-left">
          <button
            aria-label={t("sessions.expand")}
            onClick={toggleLeftCollapsed}
            type="button"
          >
            <ChevronRight size={20} />
          </button>
        </aside>
      ) : (
        <SessionList
          activeSessionId={sessionsState.activeSessionId}
          collapsedGroupNames={sessionsState.collapsedGroupNames}
          connectionStates={connectionStates}
          favoriteSessionIds={sessionsState.favoriteSessionIds}
          filter={sessionsState.filter}
          groups={sessionsState.groups}
          query={sessionsState.query}
          onCollapse={toggleLeftCollapsed}
          onCreate={() => sessionsState.setDialogState({ mode: "create" })}
          onDelete={() => void deleteSession()}
          onEdit={() =>
            sessionsState.activeSession &&
            sessionsState.setDialogState({
              mode: "edit",
              session: sessionsState.activeSession,
            })
          }
          onFilterChange={sessionsState.setFilter}
          onQueryChange={sessionsState.setQuery}
          onRefresh={() => {
            void sessionsState.refreshSessions();
            if (sessionsState.activeSessionId) {
              void connections.refreshSession(sessionsState.activeSessionId);
            }
          }}
          onSelect={sessionsState.selectSession}
          onToggleFavorite={sessionsState.toggleFavorite}
          onToggleGroup={sessionsState.toggleGroup}
        />
      )}

      <ResizeHandle
        ariaLabel={t("sessions.resizeLeft")}
        disabled={layout.leftCollapsed}
        onKeyboardResize={(direction) => adjustResize("left", direction)}
        onPointerDown={(event) => beginResize("left", event)}
        orientation="vertical"
        valueMax={WORKSPACE_LAYOUT_LIMITS.leftWidth.max}
        valueMin={WORKSPACE_LAYOUT_LIMITS.leftWidth.min}
        valueNow={layout.leftWidth}
      />

      <Workspace
        activeRuntime={activeRuntime}
        activeSessionId={sessionsState.activeSessionId}
        connectionStates={connectionStates}
        error={sessionsState.error}
        loading={sessionsState.loading}
        onCancelTransfer={(sessionId) => void connections.cancelTransfer(sessionId)}
        onDismissTransfer={connections.dismissTransfer}
        onCloseSession={(sessionId) => void closeSession(sessionId)}
        onConnected={connections.handleConnected}
        onCreateSession={() => sessionsState.setDialogState({ mode: "create" })}
        onDownload={(sessionId, file) =>
          void connections.downloadFile(sessionId, file)
        }
        onOpenPath={connections.openPath}
        onRefreshFiles={connections.refreshFiles}
        onSelectSession={sessionsState.selectSession}
        onTerminalState={connections.handleTerminalState}
        onToggleRight={toggleRightCollapsed}
        onUpload={(sessionId) => void connections.uploadFile(sessionId)}
        openSessions={sessionsState.openSessions}
        rightCollapsed={layout.rightCollapsed}
        rightResizeHandle={
          <ResizeHandle
            ariaLabel={t("sessions.resizeRight")}
            disabled={layout.rightCollapsed}
            onKeyboardResize={(direction) => adjustResize("right", direction)}
            onPointerDown={(event) => beginResize("right", event)}
            orientation="vertical"
            valueMax={WORKSPACE_LAYOUT_LIMITS.rightWidth.max}
            valueMin={WORKSPACE_LAYOUT_LIMITS.rightWidth.min}
            valueNow={layout.rightWidth}
          />
        }
        runtimes={connections.runtimes}
        verticalResizeHandle={
          <ResizeHandle
            ariaLabel={t("sessions.resizeFiles")}
            onKeyboardResize={(direction) => adjustResize("files", direction)}
            onPointerDown={(event) => beginResize("files", event)}
            orientation="horizontal"
            valueMax={WORKSPACE_LAYOUT_LIMITS.fileRatio.max}
            valueMin={WORKSPACE_LAYOUT_LIMITS.fileRatio.min}
            valueNow={layout.fileRatio}
          />
        }
        visible={visible}
      />

      {sessionsState.dialogState ? (
        <SessionFormDialog
          mode={sessionsState.dialogState.mode}
          saveError={sessionsState.saveError}
          session={sessionsState.dialogState.session}
          onClose={() => sessionsState.setDialogState(null)}
          onSave={sessionsState.saveSession}
        />
      ) : null}
    </div>
  );
}
