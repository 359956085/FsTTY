import { ChevronUp, Clock3, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { CommandHistoryEntry } from "../../shared/api/types";

interface CommandHistoryPopoverProps {
  disabled: boolean;
  onSelect: (command: string) => void;
}

export function CommandHistoryPopover({ disabled, onSelect }: CommandHistoryPopoverProps) {
  const { i18n, t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    requestRef.current += 1;
    setOpen(false);
    setQuery("");
  }, []);

  const loadInitial = useCallback(
    async (search: string) => {
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await api.listCommandHistory(search);
        if (requestId !== requestRef.current) return;
        setEntries(page.entries);
        setOlderCursor(page.olderCursor);
        setHasMore(page.hasMore);
        setActiveIndex(page.entries.length - 1);
        window.requestAnimationFrame(() => {
          const list = listRef.current;
          if (list) list.scrollTop = list.scrollHeight;
        });
      } catch (nextError) {
        if (requestId !== requestRef.current) return;
        setEntries([]);
        setOlderCursor(null);
        setHasMore(false);
        setActiveIndex(-1);
        setError(resolveApiError(nextError, t("sessions.commandHistoryLoadFailed")));
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [t],
  );

  const loadOlderEntries = useCallback(async () => {
    if (!open || !hasMore || !olderCursor || loadingOlderRef.current) return 0;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const requestId = requestRef.current;
    const list = listRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    try {
      const page = await api.listCommandHistory(query, olderCursor);
      if (requestId !== requestRef.current) return 0;
      setEntries((current) => [...page.entries, ...current]);
      setActiveIndex((current) => (current < 0 ? current : current + page.entries.length));
      setOlderCursor(page.olderCursor);
      setHasMore(page.hasMore);
      window.requestAnimationFrame(() => {
        const currentList = listRef.current;
        if (currentList) currentList.scrollTop += currentList.scrollHeight - previousHeight;
      });
      return page.entries.length;
    } catch (nextError) {
      if (requestId === requestRef.current) {
        setError(resolveApiError(nextError, t("sessions.commandHistoryLoadFailed")));
      }
      return 0;
    } finally {
      loadingOlderRef.current = false;
      if (requestId === requestRef.current) setLoadingOlder(false);
    }
  }, [hasMore, olderCursor, open, query, t]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void loadInitial(query), query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [loadInitial, open, query]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [close, open]);

  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function select(entry: CommandHistoryEntry | undefined) {
    if (!entry) return;
    close();
    onSelect(entry.command);
  }

  async function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      select(entries[activeIndex]);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, entries.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (activeIndex > 0) {
        setActiveIndex(activeIndex - 1);
      } else if (hasMore) {
        const added = await loadOlderEntries();
        if (added > 0) setActiveIndex(added - 1);
      }
    }
  }

  return (
    <div className="command-history-control" ref={rootRef}>
      {open ? (
        <section
          aria-label={t("sessions.commandHistory")}
          className="command-history-popover"
        >
          <label className="command-history-search">
            <Search aria-hidden="true" size={15} />
            <input
              aria-label={t("sessions.commandHistorySearch")}
              autoFocus
              onChange={(event) => {
                // 输入变化即使仍在防抖期，也要立刻作废旧请求，避免旧结果闪回。
                requestRef.current += 1;
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => void handleKeyDown(event)}
              placeholder={t("sessions.commandHistorySearch")}
              value={query}
            />
          </label>
          <div
            aria-busy={loading || loadingOlder}
            className="command-history-list"
            onScroll={(event) => {
              if (event.currentTarget.scrollTop <= 4) void loadOlderEntries();
            }}
            ref={listRef}
            role="listbox"
          >
            {loadingOlder ? (
              <div className="command-history-state">{t("sessions.loading")}</div>
            ) : null}
            {loading ? (
              <div className="command-history-state">{t("sessions.loading")}</div>
            ) : error ? (
              <button
                className="command-history-retry"
                onClick={() => void loadInitial(query)}
                type="button"
              >
                {error} · {t("sessions.refresh")}
              </button>
            ) : entries.length === 0 ? (
              <div className="command-history-state">{t("sessions.commandHistoryEmpty")}</div>
            ) : (
              entries.map((entry, index) => (
                <button
                  aria-selected={index === activeIndex}
                  className={`command-history-item${index === activeIndex ? " active" : ""}`}
                  key={entry.id}
                  onClick={() => select(entry)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span className="command-history-command">{entry.command}</span>
                  <time dateTime={entry.executedAt}>
                    {formatHistoryTime(entry.executedAt, i18n.resolvedLanguage)}
                  </time>
                </button>
              ))
            )}
          </div>
          <footer className="command-history-hints">
            <span>↑↓ {t("sessions.select")}</span>
            <span>Enter {t("sessions.select")}</span>
            <span>Esc {t("sessions.close")}</span>
          </footer>
        </section>
      ) : null}
      {open ? <span aria-hidden="true" className="command-history-caret" /> : null}
      <button
        aria-expanded={open}
        className="command-history-trigger"
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        type="button"
      >
        <Clock3 aria-hidden="true" size={16} />
        <span>{t("sessions.commandHistory")}</span>
        <ChevronUp aria-hidden="true" className={open ? "open" : ""} size={14} />
      </button>
    </div>
  );
}

function formatHistoryTime(value: string, language: string | undefined) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
