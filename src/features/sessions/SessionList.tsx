import { ChevronDown, Search, Server, Star } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionGroup } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";

interface SessionListProps {
  groups: SessionGroup[];
  activeSessionId: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
}

export function SessionList({
  activeSessionId,
  groups,
  query,
  onCreate,
  onQueryChange,
  onSelect,
}: SessionListProps) {
  const { t } = useTranslation();
  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return groups;
    }

    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) =>
          [session.name, session.host, session.username, ...session.tags]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [groups, query]);

  return (
    <aside className="session-sidebar">
      <header className="session-sidebar-header">
        <h2>{t("sessions.title")}</h2>
        <Button icon={<Server size={15} />} onClick={onCreate} variant="ghost">
          {t("sessions.new")}
        </Button>
      </header>

      <label className="search-box">
        <Search size={16} />
        <TextInput
          aria-label={t("sessions.search")}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("sessions.search")}
          value={query}
        />
      </label>

      <div className="session-group-list">
        {filteredGroups.map((group) => (
          <section className="session-group" key={group.name}>
            <div className="session-group-title">
              <ChevronDown size={14} />
              <span>{group.name}</span>
              <strong>{group.sessions.length}</strong>
            </div>

            {group.sessions.map((session) => (
              <button
                className={
                  activeSessionId === session.id
                    ? "session-item session-item-active"
                    : "session-item"
                }
                key={session.id}
                onClick={() => onSelect(session.id)}
                type="button"
              >
                <span className={`status-dot status-${session.status}`} />
                <span className="session-item-main">
                  <span className="session-name">{session.name}</span>
                  <span className="session-meta">
                    {session.host} · {session.username}
                  </span>
                </span>
                <span className="session-side">
                  <Star size={15} />
                  <span>{session.latencyMs ?? "-"} ms</span>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

