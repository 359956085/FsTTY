import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  MoreHorizontal,
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
  const [moreOpen, setMoreOpen] = useState(false);
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
    <aside className="session-sidebar">
      <header className="session-sidebar-header">
        <h2>{t("sessions.title")}</h2>
        <button
          aria-label={t("sessions.collapse")}
          className="icon-button"
          onClick={onCollapse}
          type="button"
        >
          <ChevronLeft size={18} />
        </button>
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

      <footer className="session-sidebar-footer">
        <button className="new-session-button" onClick={onCreate} type="button">
          <Plus size={18} />
          <span>{t("sessions.new")}</span>
        </button>
        <button
          aria-label={t("sessions.edit")}
          className="icon-button"
          disabled={!activeSessionId}
          onClick={onEdit}
          type="button"
        >
          <Pencil size={17} />
        </button>
        <div className="menu-anchor">
          <button
            aria-expanded={moreOpen}
            aria-label={t("sessions.more")}
            className="icon-button"
            onClick={() => setMoreOpen((open) => !open)}
            type="button"
          >
            <MoreHorizontal size={18} />
          </button>
          {moreOpen ? (
            <div className="popup-menu popup-menu-bottom">
              <button
                onClick={() => {
                  onRefresh();
                  setMoreOpen(false);
                }}
                type="button"
              >
                <RefreshCcw size={15} />
                {t("sessions.refresh")}
              </button>
              <button
                className="popup-menu-danger"
                disabled={!activeSessionId}
                onClick={() => {
                  onDelete();
                  setMoreOpen(false);
                }}
                type="button"
              >
                <Trash2 size={15} />
                {t("sessions.delete")}
              </button>
            </div>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}
