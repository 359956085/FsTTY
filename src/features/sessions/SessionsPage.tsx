import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "./ResizeHandle";
import { SessionFormDialog } from "./SessionFormDialog";
import { SessionList } from "./SessionList";
import { usePaneLayout } from "./usePaneLayout";
import { useSessionsPageState } from "./useSessionsPageState";
import { Workspace } from "./Workspace";
import { WORKSPACE_LAYOUT_LIMITS } from "./workspacePreferences";

export function SessionsPage() {
  const { t } = useTranslation();
  const {
    activeSession,
    activeSessionId,
    closeSessionTab,
    collapsedGroupNames,
    connection,
    currentPath,
    deleteActiveSession,
    deviceStatus,
    dialogState,
    error,
    favoriteSessionIds,
    files,
    filesLoading,
    filter,
    groups,
    loading,
    openPath,
    openSessions,
    query,
    refreshActiveSession,
    refreshFiles,
    refreshSessions,
    saveSession,
    selectSession,
    setDialogState,
    setFilter,
    setQuery,
    toggleFavorite,
    toggleGroup,
  } = useSessionsPageState({
    confirmDeleteText: t("sessions.confirmDelete"),
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

  return (
    <div
      className={layout.leftCollapsed ? "sessions-page left-collapsed" : "sessions-page"}
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
          activeSessionId={activeSessionId}
          collapsedGroupNames={collapsedGroupNames}
          favoriteSessionIds={favoriteSessionIds}
          filter={filter}
          groups={groups}
          query={query}
          onCollapse={toggleLeftCollapsed}
          onCreate={() => setDialogState({ mode: "create" })}
          onDelete={() => void deleteActiveSession()}
          onEdit={() =>
            activeSession && setDialogState({ mode: "edit", session: activeSession })
          }
          onFilterChange={setFilter}
          onQueryChange={setQuery}
          onRefresh={() => {
            void refreshSessions();
            void refreshActiveSession();
          }}
          onSelect={selectSession}
          onToggleFavorite={toggleFavorite}
          onToggleGroup={toggleGroup}
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
        activeSessionId={activeSessionId}
        connection={connection}
        currentPath={currentPath}
        deviceStatus={deviceStatus}
        error={error}
        files={files}
        filesLoading={filesLoading}
        loading={loading}
        openSessions={openSessions}
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
        onCloseSession={closeSessionTab}
        onCreateSession={() => setDialogState({ mode: "create" })}
        onOpenPath={openPath}
        onRefreshFiles={refreshFiles}
        onSelectSession={selectSession}
        onToggleRight={toggleRightCollapsed}
      />

      {dialogState ? (
        <SessionFormDialog
          mode={dialogState.mode}
          session={dialogState.session}
          onClose={() => setDialogState(null)}
          onSave={(payload) => void saveSession(payload)}
        />
      ) : null}
    </div>
  );
}
