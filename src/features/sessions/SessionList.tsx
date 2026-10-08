import { TooltipButton } from "../../shared/ui/TooltipButton";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Filter,
  Link,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type KeyboardEvent,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceSessionGroup as SessionGroup } from "../../shared/api/types";
import { isLocalSession } from "../../shared/api/types";
import { sessionDescription } from "./localSession";
import { SessionTypeIcon } from "./SessionTypeIcon";
import { Button } from "../../shared/ui/Button";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { SelectableOption } from "../../shared/ui/SelectableOption";
import { TextInput } from "../../shared/ui/TextInput";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
import { useOperationFocus } from "../../shared/ui/useOperationFocus";
import { contextMenuPosition, isComposingKey, isContextMenuKey, neighboringKeys } from "../../shared/ui/focus";
import { resolveApiError } from "../../shared/api/errors";
import { createFileOperationController } from "./fileOperationController";
import { DEFAULT_SESSION_GROUP } from "./constants";
import {
  resolveSessionDropTarget,
  type SessionDragSource,
  type SessionDropTarget,
} from "./sessionDragDrop";
import type { SessionListMutationResult } from "./useSessionsPageState";

export type SessionFilter = "all" | "favorites";

interface SessionListProps {
  groups: SessionGroup[];
  query: string;
  filter: SessionFilter;
  favoriteSessionIds: readonly string[];
  collapsedGroupNames: readonly string[];
  mutationPending: boolean;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: SessionFilter) => void;
  onOpen: (sessionId: string, autoConnect?: boolean, runAsAdmin?: boolean) => void;
  onToggleFavorite: (sessionId: string) => void;
  onToggleGroup: (groupName: string) => void;
  onCreate: MouseEventHandler<HTMLButtonElement>;
  onEdit: (sessionId: string, returnFocusTarget: HTMLElement | null) => void;
  onDelete: (sessionId: string) => void;
  onDeleteGroup: (
    groupName: string,
  ) => Promise<SessionListMutationResult<string[]>>;
  onRefresh: () => void;
  onRenameGroup: (
    groupName: string,
    newName: string,
  ) => Promise<SessionListMutationResult>;
  onReorderGroup: (groupName: string, targetIndex: number) => Promise<boolean>;
  onReorderSession: (
    sessionId: string,
    targetGroup: string,
    targetIndex: number,
  ) => Promise<boolean>;
}

type SessionContextMenu =
  | { kind: "session"; x: number; y: number; sessionId: string }
  | { kind: "group"; x: number; y: number; groupName: string };

interface DragGesture {
  pointerId: number;
  startX: number;
  startY: number;
  source: SessionDragSource;
  captureTarget: HTMLElement;
  dragging: boolean;
}

type GroupOperation =
  | {
      kind: "rename";
      groupName: string;
      sessionCount: number;
      value: string;
      error: string | null;
    }
  | {
      kind: "delete";
      groupName: string;
      sessionCount: number;
      error: string | null;
    };

export function SessionList({
  collapsedGroupNames,
  favoriteSessionIds,
  filter,
  groups,
  mutationPending,
  onCreate,
  onDelete,
  onDeleteGroup,
  onEdit,
  onFilterChange,
  onOpen,
  onQueryChange,
  onRefresh,
  onRenameGroup,
  onReorderGroup,
  onReorderSession,
  onToggleFavorite,
  onToggleGroup,
  query,
}: SessionListProps) {
  const { t } = useTranslation();
  const [filterActiveIndex, setFilterActiveIndex] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<SessionContextMenu | null>(null);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [groupOperation, setGroupOperation] = useState<GroupOperation | null>(null);
  const [groupPending, setGroupPending] = useState(false);
  const groupBusy = mutationPending || groupPending;
  const groupTitleId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogNodeRef = useRef<HTMLElement | null>(null);
  const groupControllerRef = useRef<ReturnType<typeof createFileOperationController> | null>(null);
  const groupOriginRef = useRef<{ element: HTMLElement | null; context: string; neighbors: string[] } | null>(null);
  const focusContext = JSON.stringify([query, filter]);
  const { begin: beginFocus, complete: completeFocus, isPending: focusPending } = useOperationFocus({
    context: focusContext,
    ready: !groupBusy,
    listRef,
    findTarget: (key) => key === "@dialog" && groupOperation ? dialogNodeRef.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? null : groupRefs.current.get(key) ?? null,
  });
  const { dialogRef, requestClose } = useDialogFocus({
    open: groupOperation !== null,
    canClose: !groupBusy,
    onClose: () => {
      if (!groupControllerRef.current?.isPending("dialog")) setGroupOperation(null);
    },
    initialFocus: (dialog) => dialog.querySelector("input, [data-dialog-cancel]"),
    returnFocus: () => groupOriginRef.current?.context === focusContext
      ? focusPending() ? listRef.current : groupOriginRef.current.element : null,
    fallbackFocus: () => groupOriginRef.current?.context === focusContext ? listRef.current : null,
  });
  const registerDialog = useCallback((node: HTMLElement | null) => {
    dialogNodeRef.current = node;
    const cleanup = dialogRef(node);
    return () => { dialogNodeRef.current = null; cleanup?.(); };
  }, [dialogRef]);
  useLayoutEffect(() => {
    const controller = createFileOperationController();
    groupControllerRef.current = controller;
    setGroupOperation(null);
    setGroupPending(false);
    setContextMenu(null);
    return () => { controller.dispose(); };
  }, [focusContext]);
  const [dragSource, setDragSource] = useState<SessionDragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<SessionDropTarget | null>(null);
  const dragGestureRef = useRef<DragGesture | null>(null);
  const dropTargetRef = useRef<SessionDropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const copyErrorTimerRef = useRef<number | null>(null);
  const favoriteIds = useMemo(() => new Set(favoriteSessionIds), [favoriteSessionIds]);
  const collapsedGroups = useMemo(() => new Set(collapsedGroupNames), [collapsedGroupNames]);
  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => {
          const matchesQuery =
            !normalizedQuery ||
            [session.name, sessionDescription(session), ...session.tags]
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery);
          const matchesFilter =
            filter === "all" ||
            (filter === "favorites" && favoriteIds.has(session.id));

          return matchesQuery && matchesFilter;
        }),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [favoriteIds, filter, groups, query]);

  const filterOptions: Array<{ value: SessionFilter; label: string }> = [
    { value: "all", label: t("sessions.filterAll") },
    { value: "favorites", label: t("sessions.filterFavorites") },
  ];
  const selectedFilterIndex = Math.max(
    0,
    filterOptions.findIndex((option) => option.value === filter),
  );

  function openFilterMenu() {
    setFilterActiveIndex(selectedFilterIndex);
    setFilterOpen(true);
  }

  function moveFilterActive(step: number) {
    if (!filterOpen) {
      openFilterMenu();
      return;
    }
    setFilterActiveIndex(
      (index) => (index + step + filterOptions.length) % filterOptions.length,
    );
  }

  function selectFilterOption(index: number) {
    const option = filterOptions[index];
    if (!option) {
      return;
    }
    onFilterChange(option.value);
    setFilterActiveIndex(index);
    setFilterOpen(false);
  }

  function handleFilterKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFilterActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFilterActive(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (filterOpen) {
        selectFilterOption(filterActiveIndex);
      } else {
        openFilterMenu();
      }
    } else if (event.key === "Escape" && filterOpen) {
      event.preventDefault();
      setFilterOpen(false);
    }
  }

  const dragAllowed =
    !mutationPending && query.trim().length === 0 && filter === "all";

  const clearDrag = useCallback(() => {
    const gesture = dragGestureRef.current;
    if (
      gesture &&
      gesture.captureTarget.hasPointerCapture(gesture.pointerId)
    ) {
      gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    }
    dragGestureRef.current = null;
    dropTargetRef.current = null;
    setDragSource(null);
    setDropTarget(null);
  }, []);

  useEffect(() => {
    if (!dragAllowed) {
      clearDrag();
    }
  }, [clearDrag, dragAllowed]);

  useEffect(() => {
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("blur", clearDrag);
      clearDrag();
    };
  }, [clearDrag]);

  useEffect(
    () => () => {
      if (copyErrorTimerRef.current !== null) {
        window.clearTimeout(copyErrorTimerRef.current);
      }
    },
    [],
  );

  function reportCopyError() {
    setCopyError(true);
    if (copyErrorTimerRef.current !== null) {
      window.clearTimeout(copyErrorTimerRef.current);
    }
    copyErrorTimerRef.current = window.setTimeout(() => {
      copyErrorTimerRef.current = null;
      setCopyError(false);
    }, 3000);
  }

  async function copySessionInfo(sessionId: string) {
    const session = groups
      .flatMap((group) => group.sessions)
      .find((item) => item.id === sessionId);
    if (!session) {
      reportCopyError();
      return;
    }

    const target = sessionDescription(session);
    try {
      await writeText(`${session.name} ${target}`);
      setCopyError(false);
      if (copyErrorTimerRef.current !== null) {
        window.clearTimeout(copyErrorTimerRef.current);
        copyErrorTimerRef.current = null;
      }
    } catch {
      reportCopyError();
    }
  }

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    source: SessionDragSource,
  ) {
    if (
      !dragAllowed ||
      event.button !== 0 ||
      event.pointerType !== "mouse"
    ) {
      return;
    }
    const captureTarget = event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    dragGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      source,
      captureTarget,
      dragging: false,
    };
    setContextMenu(null);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.dragging) {
      const distance = Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      );
      if (distance < 5) return;
      gesture.dragging = true;
      suppressClickRef.current = true;
      setDragSource(gesture.source);
    }
    event.preventDefault();
    const nextTarget = resolveSessionDropTarget(
      event.clientX,
      event.clientY,
      gesture.source,
    );
    dropTargetRef.current = nextTarget;
    setDropTarget(nextTarget);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const target = gesture.dragging ? dropTargetRef.current : null;
    const source = gesture.source;
    clearDrag();
    if (!target) return;

    if (source.kind === "group" && target.kind === "group") {
      const insertionIndex =
        target.groupIndex + (target.edge === "after" ? 1 : 0);
      const targetIndex =
        insertionIndex > source.groupIndex
          ? insertionIndex - 1
          : insertionIndex;
      void onReorderGroup(
        source.groupName,
        Math.max(0, Math.min(groups.length - 1, targetIndex)),
      );
      return;
    }
    if (source.kind !== "session") return;

    if (target.kind === "groupBody") {
      const targetGroup = groups.find(
        (group) => group.name === target.groupName,
      );
      if (!targetGroup) return;
      const targetIndex =
        source.groupName === target.groupName
          ? Math.max(0, targetGroup.sessions.length - 1)
          : targetGroup.sessions.length;
      void onReorderSession(source.sessionId, target.groupName, targetIndex);
      return;
    }
    if (target.kind === "session") {
      const insertionIndex =
        target.sessionIndex + (target.edge === "after" ? 1 : 0);
      const targetIndex =
        source.groupName === target.groupName &&
        insertionIndex > source.sessionIndex
          ? insertionIndex - 1
          : insertionIndex;
      void onReorderSession(
        source.sessionId,
        target.groupName,
        Math.max(0, targetIndex),
      );
    }
  }

  function consumeSuppressedClick(event: { preventDefault(): void; stopPropagation(): void }) {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function openGroupOperation(operation: GroupOperation) {
    groupOriginRef.current = {
      element: contextMenuReturnFocusRef.current,
      context: focusContext,
      neighbors: neighboringKeys(filteredGroups.map((group) => group.name), operation.groupName),
    };
    setGroupOperation(operation);
  }

  function openGroupMenu(groupName: string, target: HTMLButtonElement, pointer?: { clientX: number; clientY: number }) {
    if (groupBusy || groupOperation || groupName === DEFAULT_SESSION_GROUP) return;
    contextMenuReturnFocusRef.current = target;
    setContextMenu({ kind: "group", groupName, ...contextMenuPosition(target, pointer) });
  }

  async function submitGroupOperation() {
    const controller = groupControllerRef.current;
    if (!groupOperation || groupBusy || !controller || controller.isPending("dialog")) return;
    const value = groupOperation.kind === "rename" ? groupOperation.value.trim() : "";
    if (groupOperation.kind === "rename" && !value) {
      setGroupOperation({ ...groupOperation, error: t("sessions.groupNameRequired") });
      return;
    }
    const lease = beginFocus(dialogNodeRef.current);
    await controller.run("dialog", async () => groupOperation.kind === "rename"
      ? onRenameGroup(groupOperation.groupName, value) : onDeleteGroup(groupOperation.groupName), {
      onPendingChange: setGroupPending,
      onSuccess: (result) => {
        if (result.ok) {
          completeFocus(lease, groupOperation.kind === "rename" ? [value] : groupOriginRef.current?.neighbors ?? []);
          setGroupOperation(null);
        } else {
          setGroupOperation({ ...groupOperation, error: result.error });
          completeFocus(lease, ["@dialog"]);
        }
      },
      onError: (error) => {
        setGroupOperation({ ...groupOperation, error: resolveApiError(error, t("errors.unknown")) });
        completeFocus(lease, ["@dialog"]);
      },
    });
  }

  const contextIsLocal = contextMenu?.kind === "session" && groups.some((group) => group.sessions.some((session) => session.id === contextMenu.sessionId && isLocalSession(session)));
  return (
    <aside
      id="session-sidebar"
      className={[
        "session-sidebar",
        dragAllowed ? "session-list-drag-enabled" : "",
        dragSource ? "session-list-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={() => {
        suppressClickRef.current = false;
        clearDrag();
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <header className="session-sidebar-header">
        <h2>{t("sessions.title")}</h2>
        <div className="session-sidebar-header-actions">
          <TooltipButton
            label={t("sessions.new")}
            className="icon-button"
            disabled={mutationPending}
            onClick={onCreate}
            type="button"
          >
            <Plus size={18} />
          </TooltipButton>
          <div
            className="menu-anchor"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFilterOpen(false);
              }
            }}
          >
            <button
              aria-activedescendant={
                filterOpen ? `session-filter-option-${filterActiveIndex}` : undefined
              }
              aria-controls="session-filter-options"
              aria-expanded={filterOpen}
              aria-haspopup="listbox"
              aria-label={`${t("sessions.filter")}: ${filterOptions[selectedFilterIndex].label}`}
              className={filter === "all" ? "icon-button" : "icon-button icon-button-active"}
              onClick={() => (filterOpen ? setFilterOpen(false) : openFilterMenu())}
              onKeyDown={handleFilterKeyDown}
              role="combobox"
              type="button"
            >
              <Filter size={17} />
            </button>
            {filterOpen ? (
              <div
                className="popup-menu popup-menu-right"
                id="session-filter-options"
                role="listbox"
              >
                {filterOptions.map((option, index) => (
                  <SelectableOption
                    active={index === filterActiveIndex}
                    className="popup-menu-option"
                    id={`session-filter-option-${index}`}
                    key={option.value}
                    label={option.label}
                    onClick={() => selectFilterOption(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setFilterActiveIndex(index)}
                    selected={filter === option.value}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="session-search-row">
        <label className="search-box">
          <Search size={16} />
          <TextInput
            aria-label={t("sessions.search")}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("sessions.search")}
            value={query}
          />
        </label>
      </div>

      {copyError ? (
        <div className="session-list-copy-error error-banner" role="alert">
          {t("sessions.copySessionInfoFailed")}
        </div>
      ) : null}
      <div aria-label={t("sessions.title")} className="session-group-list" ref={listRef} role="group" tabIndex={0}>
        {filteredGroups.length === 0 ? (
          <p className="empty-message">{t("sessions.noMatches")}</p>
        ) : null}
        {filteredGroups.map((group, groupIndex) => {
          const collapsed = collapsedGroups.has(group.name);
          const groupDropClass =
            dropTarget?.kind === "group" &&
            dropTarget.groupIndex === groupIndex
              ? ` session-group-drop-${dropTarget.edge}`
              : "";
          const groupBodyTarget =
            dropTarget?.kind === "groupBody" &&
            dropTarget.groupName === group.name;

          return (
            <section
              className={`session-group${
                dragSource?.kind === "group" &&
                dragSource.groupName === group.name
                  ? " session-drag-source"
                  : ""
              }${groupDropClass}`}
              data-session-group-index={groupIndex}
              key={group.name}
            >
              <button
                aria-expanded={!collapsed}
                className={
                  groupBodyTarget
                    ? "session-group-title session-group-drop-target"
                    : "session-group-title"
                }
                data-session-drop-group={group.name}
                ref={(node) => {
                  if (node) groupRefs.current.set(group.name, node);
                  else groupRefs.current.delete(group.name);
                }}
                onClick={(event) => {
                  if (consumeSuppressedClick(event)) return;
                  onToggleGroup(group.name);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openGroupMenu(group.name, event.currentTarget, event);
                }}
                onKeyDown={(event) => {
                  if (event.defaultPrevented || isComposingKey(event.nativeEvent) || !isContextMenuKey(event)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  openGroupMenu(group.name, event.currentTarget);
                }}
                onPointerDown={(event) =>
                  beginDrag(event, {
                    kind: "group",
                    groupName: group.name,
                    groupIndex,
                  })
                }
                type="button"
              >
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span>
                  {group.name === DEFAULT_SESSION_GROUP ? t("sessions.ungrouped") : group.name}
                </span>
                <strong>{group.sessions.length}</strong>
              </button>

              {!collapsed
                ? group.sessions.map((session, sessionIndex) => {
                    const sessionDropClass =
                      dropTarget?.kind === "session" &&
                      dropTarget.groupName === group.name &&
                      dropTarget.sessionIndex === sessionIndex
                        ? ` session-item-drop-${dropTarget.edge}`
                        : "";
                    return (
                    <div
                      className={
                        `session-item${
                          dragSource?.kind === "session" &&
                          dragSource.sessionId === session.id
                            ? " session-drag-source"
                            : ""
                        }${sessionDropClass}`
                      }
                      data-session-group-name={group.name}
                      data-session-index={sessionIndex}
                      key={session.id}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        contextMenuReturnFocusRef.current = event.currentTarget.querySelector(".session-item-select");
                        setContextMenu({
                          kind: "session",
                          ...contextMenuPosition(contextMenuReturnFocusRef.current ?? event.currentTarget, event),
                          sessionId: session.id,
                        });
                      }}
                      onKeyDown={(event) => {
                        if (event.defaultPrevented || isComposingKey(event.nativeEvent) || !isContextMenuKey(event)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const target = event.currentTarget.querySelector<HTMLButtonElement>(".session-item-select");
                        if (!target) return;
                        contextMenuReturnFocusRef.current = target;
                        setContextMenu({ kind: "session", sessionId: session.id, ...contextMenuPosition(target) });
                      }}
                    >
                      <button
                        className="session-item-select"
                        onClick={(event) => {
                          consumeSuppressedClick(event);
                        }}
                        onPointerDown={(event) =>
                          beginDrag(event, {
                            kind: "session",
                            sessionId: session.id,
                            groupName: group.name,
                            sessionIndex,
                          })
                        }
                        type="button"
                      >
                        <SessionTypeIcon type={isLocalSession(session) ? session.shell : "ssh"} />
                        <span className="session-item-main">
                          <span className="session-name">{session.name}</span>
                          <span className="session-meta">
                            {isLocalSession(session)
                              ? t(session.runAsAdmin ? "local.admin" : "local.standard")
                              : sessionDescription(session)}
                          </span>
                        </span>
                      </button>
                      <button
                        aria-label={`${t("sessions.filterFavorites")} ${session.name}`}
                        className={
                          favoriteIds.has(session.id)
                            ? "session-favorite session-favorite-active"
                            : "session-favorite"
                        }
                        onClick={() => onToggleFavorite(session.id)}
                        type="button"
                      >
                        <Star fill={favoriteIds.has(session.id) ? "currentColor" : "none"} size={17} />
                      </button>
                    </div>
                    );
                  })
                : null}
            </section>
          );
        })}
      </div>

      {contextMenu?.kind === "session" ? (
        <ContextMenu
          items={[
            { id: "connect", label: t(contextIsLocal ? "local.start" : "sessions.contextConnect"), icon: <Link size={15} />, onSelect: () => onOpen(contextMenu.sessionId) },
            ...(contextIsLocal ? [
              { id: "local-normal", label: t("local.openNormal"), onSelect: () => onOpen(contextMenu.sessionId, true, false) },
              { id: "local-admin", label: t("local.openAdmin"), onSelect: () => onOpen(contextMenu.sessionId, true, true) },
            ] : []),
            { id: "copy-session-info", label: t("sessions.contextCopySessionInfo"), icon: <Copy size={15} />, onSelect: () => void copySessionInfo(contextMenu.sessionId) },
            { id: "edit", label: t("sessions.edit"), icon: <Pencil size={15} />, disabled: mutationPending, onSelect: () => onEdit(contextMenu.sessionId, contextMenuReturnFocusRef.current) },
            { id: "favorite", label: t(favoriteIds.has(contextMenu.sessionId) ? "sessions.unfavorite" : "sessions.favorite"), icon: <Star size={15} />, onSelect: () => onToggleFavorite(contextMenu.sessionId) },
            { id: "refresh", label: t("sessions.refresh"), icon: <RefreshCcw size={15} />, disabled: mutationPending, onSelect: onRefresh },
            { id: "delete", label: t("sessions.delete"), icon: <Trash2 size={15} />, danger: true, disabled: mutationPending, onSelect: () => onDelete(contextMenu.sessionId) },
          ]}
          onClose={() => setContextMenu(null)}
          returnFocus={() => contextMenuReturnFocusRef.current}
          fallbackFocus={() => listRef.current}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
      {contextMenu?.kind === "group" ? (
        <ContextMenu
          items={[
            {
              id: "rename-group",
              label: t("sessions.renameGroup"),
              icon: <Pencil size={15} />,
              disabled: mutationPending,
              onSelect: () => {
                const group = groups.find(
                  (item) => item.name === contextMenu.groupName,
                );
                if (!group) return;
                openGroupOperation({
                  kind: "rename",
                  groupName: group.name,
                  sessionCount: group.sessions.length,
                  value: group.name,
                  error: null,
                });
              },
            },
            {
              id: "delete-group",
              label: t("sessions.deleteGroup"),
              icon: <Trash2 size={15} />,
              danger: true,
              disabled: mutationPending,
              onSelect: () => {
                const group = groups.find(
                  (item) => item.name === contextMenu.groupName,
                );
                if (!group) return;
                openGroupOperation({
                  kind: "delete",
                  groupName: group.name,
                  sessionCount: group.sessions.length,
                  error: null,
                });
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
          returnFocus={() => contextMenuReturnFocusRef.current}
          fallbackFocus={() => listRef.current}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
      {groupOperation ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section
            aria-modal="true"
            aria-labelledby={groupTitleId}
            className="dialog group-operation-dialog"
            ref={registerDialog}
            role="dialog"
            tabIndex={-1}
          >
            <header className="dialog-header">
              <h2 id={groupTitleId}>
                {t(
                  groupOperation.kind === "rename"
                    ? "sessions.renameGroup"
                    : "sessions.deleteGroup",
                )}
              </h2>
            </header>
            <div className="group-operation-body">
              {groupOperation.kind === "rename" ? (
                <label>
                  <span>{t("sessions.groupName")}</span>
                  <TextInput
                    disabled={groupBusy}
                    maxLength={128}
                    onChange={(event) =>
                      setGroupOperation({
                        ...groupOperation,
                        value: event.target.value,
                        error: null,
                      })
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.defaultPrevented && !isComposingKey(event.nativeEvent) && !event.repeat
                      ) {
                        event.preventDefault();
                        void submitGroupOperation();
                      }
                    }}
                    value={groupOperation.value}
                  />
                </label>
              ) : (
                <>
                  <p>
                    {t("sessions.confirmDeleteGroup", {
                      name: groupOperation.groupName,
                      count: groupOperation.sessionCount,
                    })}
                  </p>
                  <p className="group-operation-warning">
                    {t("sessions.deleteGroupWarning")}
                  </p>
                </>
              )}
            </div>
            {groupOperation.error ? (
              <div className="form-error" role="alert">{groupOperation.error}</div>
            ) : null}
            <footer className="dialog-actions">
              <Button
                data-dialog-cancel
                disabled={groupBusy}
                onClick={requestClose}
                variant="ghost"
              >
                {t("sessions.cancel")}
              </Button>
              <Button
                disabled={groupBusy}
                icon={
                  groupOperation.kind === "rename" ? (
                    <Save aria-hidden="true" size={16} />
                  ) : (
                    <Trash2 aria-hidden="true" size={16} />
                  )
                }
                onClick={() => void submitGroupOperation()}
                variant={
                  groupOperation.kind === "rename" ? "primary" : "danger"
                }
              >
                {t(
                  groupOperation.kind === "rename"
                    ? "sessions.save"
                    : "sessions.deleteGroup",
                )}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
