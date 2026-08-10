import { ChevronUp, Clock3, Search } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { CommandHistoryEntry, ShortcutSettings } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS, formatShortcut, matchesShortcut } from "../../shared/shortcuts";
import {
  COMMAND_HISTORY_POPOVER_LIMITS,
  readWorkspacePreferences,
  updateWorkspacePreferences,
  type CommandHistoryPopoverPreferences,
} from "./workspacePreferences";

interface CommandHistoryPopoverProps {
  disabled: boolean;
  onTriggerClose?: () => void;
  onSelect: (command: string) => void;
  shortcuts?: ShortcutSettings;
}

export interface CommandHistoryPopoverHandle {
  focusSearch: () => void;
  toggle: () => void;
}

type ResizeAxis = "height" | "width" | "both";

interface AvailableSize {
  width: number;
  height: number;
}

export const CommandHistoryPopover = forwardRef<
  CommandHistoryPopoverHandle,
  CommandHistoryPopoverProps
>(function CommandHistoryPopover(
  { disabled, onSelect, onTriggerClose, shortcuts = DEFAULT_SHORTCUTS },
  forwardedRef,
) {
  const { i18n, t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hintsRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const removeResizeListenersRef = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popoverSize, setPopoverSize] = useState<CommandHistoryPopoverPreferences | null>(
    () => readWorkspacePreferences().commandHistoryPopover,
  );
  const [availableSize, setAvailableSize] = useState<AvailableSize | null>(null);
  const [minimumWidth, setMinimumWidth] = useState<number>(
    COMMAND_HISTORY_POPOVER_LIMITS.width.min,
  );

  const readAvailableSize = useCallback((): AvailableSize | null => {
    const root = rootRef.current;
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    const terminalRect = root.closest<HTMLElement>(".terminal-wrap")?.getBoundingClientRect();
    const available = {
      width: Math.max(0, rootRect.width),
      height: Math.max(0, rootRect.top - 8 - (terminalRect?.top ?? 0)),
    };
    return available.width > 0 && available.height > 0 ? available : null;
  }, []);

  const close = useCallback(() => {
    requestRef.current += 1;
    setOpen(false);
    setQuery("");
  }, []);

  const openPopover = useCallback(() => {
    if (disabled) return;
    setPopoverSize(readWorkspacePreferences().commandHistoryPopover);
    setOpen(true);
  }, [disabled]);

  const focusSearch = useCallback(() => {
    if (disabled) return;
    openPopover();
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [disabled, openPopover]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focusSearch,
      toggle: () => {
        if (open) close();
        else openPopover();
      },
    }),
    [close, focusSearch, open, openPopover],
  );

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
    if (!open) return;
    const updateLayoutBounds = () => {
      setAvailableSize(readAvailableSize());
      setMinimumWidth(measureHistoryHintsWidth(hintsRef.current));
    };
    updateLayoutBounds();
    window.addEventListener("resize", updateLayoutBounds);
    const terminal = rootRef.current?.closest<HTMLElement>(".terminal-wrap");
    const observer =
      terminal && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateLayoutBounds)
        : null;
    if (terminal) observer?.observe(terminal);
    return () => {
      window.removeEventListener("resize", updateLayoutBounds);
      observer?.disconnect();
    };
  }, [i18n.resolvedLanguage, open, readAvailableSize]);

  useEffect(
    () => () => {
      removeResizeListenersRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function select(entry: CommandHistoryEntry | undefined) {
    if (!entry) return;
    close();
    onSelect(entry.command);
  }

  function clampSize(
    size: CommandHistoryPopoverPreferences,
    available: AvailableSize,
  ): CommandHistoryPopoverPreferences {
    const minWidth = Math.min(minimumWidth, available.width);
    const minHeight = Math.min(COMMAND_HISTORY_POPOVER_LIMITS.height.min, available.height);
    return {
      width: Math.min(Math.max(size.width, minWidth), available.width),
      height: Math.min(Math.max(size.height, minHeight), available.height),
    };
  }

  function savePopoverSize(size: CommandHistoryPopoverPreferences) {
    setPopoverSize(size);
    updateWorkspacePreferences({ commandHistoryPopover: size });
  }

  function beginResize(axis: ResizeAxis, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const popover = popoverRef.current;
    const available = readAvailableSize();
    if (!popover || !available || available.width <= 0 || available.height <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    removeResizeListenersRef.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const bounds = popover.getBoundingClientRect();
    let currentSize = { width: bounds.width, height: bounds.height };
    let changed = false;

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // WebView 不支持捕获时，窗口级监听仍可完成拖动。
    }

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", finishResize);
      removeResizeListenersRef.current = null;
      if (changed) savePopoverSize(currentSize);
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const next = clampSize(
        {
          width:
            axis === "height" ? bounds.width : bounds.width + moveEvent.clientX - startX,
          height:
            axis === "width" ? bounds.height : bounds.height + startY - moveEvent.clientY,
        },
        readAvailableSize() ?? available,
      );
      currentSize = next;
      changed = true;
      setPopoverSize(next);
    };
    const finishResize = (finishEvent: PointerEvent | Event) => {
      if ("pointerId" in finishEvent && finishEvent.pointerId !== pointerId) return;
      cleanup();
    };

    removeResizeListenersRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("blur", finishResize);
  }

  function resizeWithKeyboard(axis: Exclude<ResizeAxis, "both">, event: KeyboardEvent) {
    const popover = popoverRef.current;
    const available = readAvailableSize();
    if (!popover || !available) return;
    const bounds = popover.getBoundingClientRect();
    let delta = 0;
    if (axis === "width" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      delta = event.key === "ArrowRight" ? 16 : -16;
    }
    if (axis === "height" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      delta = event.key === "ArrowUp" ? 16 : -16;
    }
    if (delta === 0) return;
    event.preventDefault();
    savePopoverSize(
      clampSize(
        {
          width: axis === "width" ? bounds.width + delta : bounds.width,
          height: axis === "height" ? bounds.height + delta : bounds.height,
        },
        available,
      ),
    );
  }

  async function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (matchesShortcut(event.nativeEvent, shortcuts.commandHistory)) {
      event.preventDefault();
      close();
      return;
    }
    if (matchesShortcut(event.nativeEvent, shortcuts.commandHistorySearch)) {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
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
          ref={popoverRef}
          style={
            {
              ...(popoverSize && availableSize
                ? {
                    width: Math.min(popoverSize.width, availableSize.width),
                    minWidth: Math.min(minimumWidth, availableSize.width),
                    height: Math.min(popoverSize.height, availableSize.height),
                  }
                : {}),
              maxWidth: availableSize?.width,
              maxHeight: availableSize
                ? popoverSize
                  ? availableSize.height
                  : Math.min(430, availableSize.height)
                : undefined,
            } satisfies CSSProperties
          }
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
              placeholder={`${t("sessions.commandHistorySearch")} (${formatShortcut(shortcuts.commandHistorySearch)})`}
              ref={searchRef}
              value={query}
            />
          </label>
          <div className="command-history-list-frame">
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
          </div>
          <footer className="command-history-hints" ref={hintsRef}>
            <span>↑↓ {t("sessions.select")}</span>
            <span>Enter {t("sessions.select")}</span>
            <span>Esc {t("sessions.close")}</span>
          </footer>
          <div
            aria-label={t("sessions.resizeCommandHistoryHeight")}
            aria-orientation="horizontal"
            className="command-history-resizer command-history-resizer-top"
            onKeyDown={(event) => resizeWithKeyboard("height", event)}
            onPointerDown={(event) => beginResize("height", event)}
            role="separator"
            tabIndex={0}
          />
          <div
            aria-label={t("sessions.resizeCommandHistoryWidth")}
            aria-orientation="vertical"
            className="command-history-resizer command-history-resizer-right"
            onKeyDown={(event) => resizeWithKeyboard("width", event)}
            onPointerDown={(event) => beginResize("width", event)}
            role="separator"
            tabIndex={0}
          />
          <span
            aria-hidden="true"
            className="command-history-resizer command-history-resizer-corner"
            onPointerDown={(event) => beginResize("both", event)}
          />
        </section>
      ) : null}
      {open ? <span aria-hidden="true" className="command-history-caret" /> : null}
      <button
        aria-expanded={open}
        className="command-history-trigger"
        disabled={disabled}
        title={`${t("sessions.commandHistory")} (${formatShortcut(shortcuts.commandHistory)})`}
        onClick={() => {
          if (open) {
            close();
            onTriggerClose?.();
          } else {
            openPopover();
          }
        }}
        type="button"
      >
        <Clock3 aria-hidden="true" size={16} />
        <span>{t("sessions.commandHistory")}</span>
        <ChevronUp aria-hidden="true" className={open ? "open" : ""} size={14} />
      </button>
    </div>
  );
});

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

function measureHistoryHintsWidth(element: HTMLElement | null) {
  if (!element) return COMMAND_HISTORY_POPOVER_LIMITS.width.min;
  const style = window.getComputedStyle(element);
  const childrenWidth = Array.from(element.children).reduce(
    (total, child) => total + child.getBoundingClientRect().width,
    0,
  );
  const columnGap = Number.parseFloat(style.columnGap);
  const gap = Number.isFinite(columnGap) ? columnGap : Number.parseFloat(style.gap) || 0;
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) +
    (Number.parseFloat(style.paddingRight) || 0);
  const measured = Math.ceil(
    childrenWidth + gap * Math.max(0, element.children.length - 1) + padding + 2,
  );
  return Math.max(COMMAND_HISTORY_POPOVER_LIMITS.width.min, measured);
}
