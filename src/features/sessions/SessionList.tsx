import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { SessionGroup } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { SelectableOption } from "../../shared/ui/SelectableOption";
import { TextInput } from "../../shared/ui/TextInput";
import { DEFAULT_SESSION_GROUP } from "./constants";
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
  onOpen: (sessionId: string) => void;
  onToggleFavorite: (sessionId: string) => void;
  onToggleGroup: (groupName: string) => void;
  onCreate: () => void;
  onEdit: (sessionId: string) => void;
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
  onCollapse: () => void;
}

type SessionContextMenu =
  | { kind: "session"; x: number; y: number; sessionId: string }
  | { kind: "group"; x: number; y: number; groupName: string };

type DragSource =
  | { kind: "group"; groupName: string; groupIndex: number }
  | {
      kind: "session";
      sessionId: string;
      groupName: string;
      sessionIndex: number;
    };

type DropTarget =
  | { kind: "group"; groupIndex: number; edge: "before" | "after" }
  | {
      kind: "session";
      groupName: string;
      sessionIndex: number;
      edge: "before" | "after";
    }
  | { kind: "groupBody"; groupName: string };

interface DragGesture {
  pointerId: number;
  startX: number;
  startY: number;
  source: DragSource;
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
  onCollapse,
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
  const [groupOperation, setGroupOperation] = useState<GroupOperation | null>(null);
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dragGestureRef = useRef<DragGesture | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const suppressClickRef = useRef(false);
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
            [session.name, session.host, session.username, ...session.tags]
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

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    source: DragSource,
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
    const nextTarget = resolveDropTarget(
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

  async function submitGroupOperation() {
    if (!groupOperation || mutationPending) return;
    if (groupOperation.kind === "rename") {
      const value = groupOperation.value.trim();
      if (!value) {
        setGroupOperation({
          ...groupOperation,
          error: t("sessions.groupNameRequired"),
        });
        return;
      }
      const result = await onRenameGroup(groupOperation.groupName, value);
      if (result.ok) {
        setGroupOperation(null);
      } else {
        setGroupOperation({ ...groupOperation, error: result.error });
      }
      return;
    }
    const result = await onDeleteGroup(groupOperation.groupName);
    if (result.ok) {
      setGroupOperation(null);
    } else {
      setGroupOperation({ ...groupOperation, error: result.error });
    }
  }

  return (
    <aside
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
        <span className="session-sidebar-header-actions">
          <button
            aria-label={t("sessions.new")}
            className="icon-button"
            disabled={mutationPending}
            onClick={onCreate}
            type="button"
          >
            <Plus size={18} />
          </button>
          <button aria-label={t("sessions.collapse")} className="icon-button" onClick={onCollapse} type="button">
            <ChevronLeft size={18} />
          </button>
        </span>
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

      <div className="session-group-list">
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
                onClick={(event) => {
                  if (consumeSuppressedClick(event)) return;
                  onToggleGroup(group.name);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (
                    mutationPending ||
                    group.name === DEFAULT_SESSION_GROUP
                  ) {
                    return;
                  }
                  setContextMenu({
                    kind: "group",
                    x: event.clientX,
                    y: event.clientY,
                    groupName: group.name,
                  });
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
                        setContextMenu({
                          kind: "session",
                          x: event.clientX,
                          y: event.clientY,
                          sessionId: session.id,
                        });
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
                        <span className="session-item-main">
                          <span className="session-name">{session.name}</span>
                          <span className="session-meta">
                            {session.username
                              ? `${session.username}@${session.host}`
                              : session.host}
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
            { id: "connect", label: t("sessions.contextConnect"), icon: <Link size={15} />, onSelect: () => onOpen(contextMenu.sessionId) },
            { id: "edit", label: t("sessions.edit"), icon: <Pencil size={15} />, disabled: mutationPending, onSelect: () => onEdit(contextMenu.sessionId) },
            { id: "favorite", label: t(favoriteIds.has(contextMenu.sessionId) ? "sessions.unfavorite" : "sessions.favorite"), icon: <Star size={15} />, onSelect: () => onToggleFavorite(contextMenu.sessionId) },
            { id: "refresh", label: t("sessions.refresh"), icon: <RefreshCcw size={15} />, disabled: mutationPending, onSelect: onRefresh },
            { id: "delete", label: t("sessions.delete"), icon: <Trash2 size={15} />, danger: true, disabled: mutationPending, onSelect: () => onDelete(contextMenu.sessionId) },
          ]}
          onClose={() => setContextMenu(null)}
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
                setGroupOperation({
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
                setGroupOperation({
                  kind: "delete",
                  groupName: group.name,
                  sessionCount: group.sessions.length,
                  error: null,
                });
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
      {groupOperation ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section
            aria-modal="true"
            className="dialog group-operation-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !mutationPending) {
                event.preventDefault();
                setGroupOperation(null);
              }
            }}
            role="dialog"
          >
            <header className="dialog-header">
              <h2>
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
                    autoFocus
                    disabled={mutationPending}
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
                        !event.nativeEvent.isComposing
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
              <div className="form-error">{groupOperation.error}</div>
            ) : null}
            <footer className="dialog-actions">
              <Button
                disabled={mutationPending}
                onClick={() => setGroupOperation(null)}
                variant="ghost"
              >
                {t("sessions.cancel")}
              </Button>
              <Button
                disabled={mutationPending}
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

function resolveDropTarget(
  clientX: number,
  clientY: number,
  source: DragSource,
): DropTarget | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof HTMLElement)) return null;

  if (source.kind === "group") {
    const groupTitle = element.closest<HTMLElement>(
      "[data-session-drop-group]",
    );
    const groupElement = groupTitle?.closest<HTMLElement>(
      "[data-session-group-index]",
    );
    if (!groupElement || !groupTitle) return null;
    const groupIndex = Number(groupElement.dataset.sessionGroupIndex);
    if (!Number.isInteger(groupIndex)) return null;
    const rectangle = groupTitle.getBoundingClientRect();
    return {
      kind: "group",
      groupIndex,
      edge: clientY < rectangle.top + rectangle.height / 2 ? "before" : "after",
    };
  }

  const sessionElement = element.closest<HTMLElement>("[data-session-index]");
  if (sessionElement) {
    const sessionIndex = Number(sessionElement.dataset.sessionIndex);
    const groupName = sessionElement.dataset.sessionGroupName;
    if (Number.isInteger(sessionIndex) && groupName) {
      const rectangle = sessionElement.getBoundingClientRect();
      return {
        kind: "session",
        groupName,
        sessionIndex,
        edge:
          clientY < rectangle.top + rectangle.height / 2 ? "before" : "after",
      };
    }
  }

  const groupTitle = element.closest<HTMLElement>("[data-session-drop-group]");
  const groupName = groupTitle?.dataset.sessionDropGroup;
  return groupName ? { kind: "groupBody", groupName } : null;
}
