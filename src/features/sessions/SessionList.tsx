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
  Star,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionState, SessionGroup } from "../../shared/api/types";
import { TextInput } from "../../shared/ui/TextInput";
import { ContextMenu } from "../../shared/ui/ContextMenu";

export type SessionFilter = "all" | "online" | "offline" | "favorites";

interface SessionListProps {
  groups: SessionGroup[];
  activeSessionId: string | null;
  query: string;
  filter: SessionFilter;
  favoriteSessionIds: readonly string[];
  collapsedGroupNames: readonly string[];
  connectionStates: Readonly<Record<string, ConnectionState>>;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: SessionFilter) => void;
  onSelect: (sessionId: string) => void;
  onToggleFavorite: (sessionId: string) => void;
  onToggleGroup: (groupName: string) => void;
  onCreate: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onCollapse: () => void;
}

export function SessionList({
  activeSessionId,
  collapsedGroupNames,
  connectionStates,
  favoriteSessionIds,
  filter,
  groups,
  onCollapse,
  onCreate,
  onDelete,
  onEdit,
  onFilterChange,
  onQueryChange,
  onRefresh,
  onSelect,
  onToggleFavorite,
  onToggleGroup,
  query,
}: SessionListProps) {
  const { t } = useTranslation();
  const [filterOpen, setFilterOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
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
            (filter === "favorites"
              ? favoriteIds.has(session.id)
              : (connectionStates[session.id] === "connected" ? "online" : "offline") === filter);

          return matchesQuery && matchesFilter;
        }),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [connectionStates, favoriteIds, filter, groups, query]);

  const filterOptions: Array<{ value: SessionFilter; label: string }> = [
    { value: "all", label: t("sessions.filterAll") },
    { value: "online", label: t("sessions.filterOnline") },
    { value: "offline", label: t("sessions.filterOffline") },
    { value: "favorites", label: t("sessions.filterFavorites") },
  ];

  return (
    <aside className="session-sidebar" onContextMenu={(event) => event.preventDefault()}>
      <header className="session-sidebar-header">
        <h2>{t("sessions.title")}</h2>
        <span className="session-sidebar-header-actions">
          <button aria-label={t("sessions.new")} className="icon-button" onClick={onCreate} type="button">
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
        <div className="menu-anchor">
          <button
            aria-expanded={filterOpen}
            aria-label={t("sessions.filter")}
            className={filter === "all" ? "icon-button" : "icon-button icon-button-active"}
            onClick={() => setFilterOpen((open) => !open)}
            type="button"
          >
            <Filter size={17} />
          </button>
          {filterOpen ? (
            <div className="popup-menu popup-menu-right">
              {filterOptions.map((option) => (
                <button
                  className={filter === option.value ? "popup-menu-active" : ""}
                  key={option.value}
                  onClick={() => {
                    onFilterChange(option.value);
                    setFilterOpen(false);
                  }}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="session-group-list">
        {filteredGroups.length === 0 ? (
          <p className="empty-message">{t("sessions.noMatches")}</p>
        ) : null}
        {filteredGroups.map((group) => {
          const collapsed = collapsedGroups.has(group.name);

          return (
            <section className="session-group" key={group.name}>
              <button
                aria-expanded={!collapsed}
                className="session-group-title"
                onClick={() => onToggleGroup(group.name)}
                type="button"
              >
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span>{group.name}</span>
                <strong>{group.sessions.length}</strong>
              </button>

              {!collapsed
                ? group.sessions.map((session) => (
                    <div
                      className={
                        activeSessionId === session.id
                          ? "session-item session-item-active"
                          : "session-item"
                      }
                      key={session.id}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onSelect(session.id);
                        setContextMenu({ x: event.clientX, y: event.clientY });
                      }}
                    >
                      <button
                        className="session-item-select"
                        onClick={() => onSelect(session.id)}
                        type="button"
                      >
                        <span
                          className={`status-dot status-${
                            connectionStates[session.id] === "connected"
                              ? "online"
                              : "offline"
                          }`}
                        />
                        <span className="session-item-main">
                          <span className="session-name">{session.name}</span>
                          <span className="session-meta">
                            {session.username}@{session.host}
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
                  ))
                : null}
            </section>
          );
        })}
      </div>

      {contextMenu ? (
        <ContextMenu
          items={[
            { id: "connect", label: t("sessions.contextConnect"), icon: <Link size={15} />, onSelect: () => activeSessionId && onSelect(activeSessionId) },
            { id: "edit", label: t("sessions.edit"), icon: <Pencil size={15} />, onSelect: onEdit },
            { id: "favorite", label: t(favoriteIds.has(activeSessionId ?? "") ? "sessions.unfavorite" : "sessions.favorite"), icon: <Star size={15} />, onSelect: () => activeSessionId && onToggleFavorite(activeSessionId) },
            { id: "refresh", label: t("sessions.refresh"), icon: <RefreshCcw size={15} />, onSelect: onRefresh },
            { id: "delete", label: t("sessions.delete"), icon: <Trash2 size={15} />, danger: true, disabled: !activeSessionId, onSelect: onDelete },
          ]}
          onClose={() => setContextMenu(null)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
    </aside>
  );
}
