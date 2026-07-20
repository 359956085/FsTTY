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
  const validRuntimeIds = useMemo(
    () => new Set(sessionsState.openSessionTabs.map((tab) => tab.id)),
    [sessionsState.openSessionTabs],
  );

  useEffect(() => {
    connections.pruneRuntimes(validRuntimeIds);
  }, [connections.pruneRuntimes, validRuntimeIds]);

  const connectionStates = useMemo(
    () =>
      Object.fromEntries(
        sessionsState.openSessionTabs.map((tab) => [
          tab.id,
          connections.runtimes[tab.id]?.connectionState ?? "disconnected",
        ]),
      ),
    [connections.runtimes, sessionsState.openSessionTabs],
  );
  const activeRuntime = sessionsState.activeTabId
    ? connections.runtimes[sessionsState.activeTabId] ?? createRuntime()
    : createRuntime();

  async function closeTab(tabId: string) {
    await connections.disconnect(tabId);
    connections.removeRuntime(tabId);
    sessionsState.closeSessionTab(tabId);
  }

  async function deleteSession(sessionId: string) {
    const affectedTabs = sessionsState.openSessionTabs.filter(
      (tab) => tab.sessionId === sessionId,
    );
    const deletedId = await sessionsState.deleteSession(sessionId);
    if (deletedId) {
      affectedTabs.forEach((tab) => connections.removeRuntime(tab.id));
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
          collapsedGroupNames={sessionsState.collapsedGroupNames}
          favoriteSessionIds={sessionsState.favoriteSessionIds}
          filter={sessionsState.filter}
          groups={sessionsState.groups}
          query={sessionsState.query}
          onCollapse={toggleLeftCollapsed}
          onCreate={() => sessionsState.setDialogState({ mode: "create" })}
          onDelete={(sessionId) => void deleteSession(sessionId)}
          onEdit={(sessionId) => {
            const session = sessionsState.sessions.find((item) => item.id === sessionId);
            if (session) {
              sessionsState.setDialogState({ mode: "edit", session });
            }
          }}
          onFilterChange={sessionsState.setFilter}
          onQueryChange={sessionsState.setQuery}
          onOpen={sessionsState.openSessionTab}
          onRefresh={() => void sessionsState.refreshSessions()}
          onSelect={sessionsState.selectSession}
          selectedSessionId={sessionsState.selectedSessionId}
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
        activeTabId={sessionsState.activeTabId}
        connectionStates={connectionStates}
        error={sessionsState.error}
        loading={sessionsState.loading}
        onCancelTransfer={(sessionId) => void connections.cancelTransfer(sessionId)}
        onDismissTransfer={connections.dismissTransfer}
        onCloseTab={(tabId) => void closeTab(tabId)}
        onConnected={connections.handleConnected}
        onCreateSession={() => sessionsState.setDialogState({ mode: "create" })}
        onDirectoryChange={connections.handleTerminalDirectory}
        onDownload={(sessionId, file) =>
          void connections.downloadFile(sessionId, file)
        }
        onOpenPath={connections.openPath}
        onRefreshFiles={connections.refreshFiles}
        onSelectTab={sessionsState.selectTab}
        onTerminalState={connections.handleTerminalState}
        onToggleRight={toggleRightCollapsed}
        onUpload={(sessionId) => void connections.uploadFile(sessionId)}
        openTabs={sessionsState.openSessionTabs}
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
          groupOptions={sessionsState.groups.map((group) => group.name)}
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
