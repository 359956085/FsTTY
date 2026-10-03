import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { isComposingKey, isFocusAvailable } from "./focus";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export type ContextMenuCloseReason = "escape" | "tab" | "selection" | "outside" | "layout";

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: (reason: ContextMenuCloseReason) => void;
  returnFocus?: () => HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
}

export function ContextMenu({ items, onClose, returnFocus, fallbackFocus, x, y }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options = useRef({ onClose, returnFocus, fallbackFocus });
  const previousFocus = useRef<HTMLElement | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const closed = useRef(false);
  useLayoutEffect(() => { options.current = { onClose, returnFocus, fallbackFocus }; });

  const enabledButtons = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []).filter(isFocusAvailable);
  const close = useCallback((reason: ContextMenuCloseReason) => {
    if (closed.current) return false;
    closed.current = true;
    // Restore before invoking an action so a new dialog/editor can take ownership.
    if (reason !== "outside" && menuRef.current?.contains(document.activeElement)) {
      const target = options.current.returnFocus ? options.current.returnFocus() : previousFocus.current;
      const fallback = options.current.fallbackFocus?.();
      if (isFocusAvailable(target)) target.focus({ preventScroll: true });
      else if (isFocusAvailable(fallback)) fallback.focus({ preventScroll: true });
    }
    options.current.onClose(reason);
    return true;
  }, []);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    closed.current = false;
    if (!menu?.contains(document.activeElement)) previousFocus.current = document.activeElement as HTMLElement | null;
    (enabledButtons()[0] ?? menu)?.focus({ preventScroll: true });
  }, [x, y]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const active = document.activeElement;
    if (!closed.current && ((menu?.contains(active) && (active === menu || !isFocusAvailable(active as HTMLElement)))
      || (active === document.body && lastFocus.current && !isFocusAvailable(lastFocus.current)))) {
      (enabledButtons()[0] ?? menu)?.focus({ preventScroll: true });
    }
  }, [items]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close("outside");
    };
    const layout = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close("layout");
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", layout);
    window.addEventListener("scroll", layout, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", layout);
      window.removeEventListener("scroll", layout, true);
    };
  }, [close]);

  return (
    <div
      className="context-menu"
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={(event) => { lastFocus.current = event.target; }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || isComposingKey(event.nativeEvent) || !menuRef.current?.contains(document.activeElement)) return;
        if (event.key === "Tab") {
          event.stopPropagation();
          close("tab");
          // Let the browser continue Tab navigation from the restored opener.
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close("escape");
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const buttons = enabledButtons();
          if (!buttons.length) return;
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : event.key === "ArrowDown" ? (current + 1) % buttons.length
              : (current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length);
          buttons[next]?.focus();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat && document.activeElement instanceof HTMLButtonElement) document.activeElement.click();
        }
      }}
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      style={{ left: Math.max(0, Math.min(x, window.innerWidth - 220)), top: Math.max(0, Math.min(y, window.innerHeight - items.length * 36 - 12)) }}
    >
      {items.map((item) => (
        <button
          className={item.danger ? "context-menu-danger" : ""}
          disabled={item.disabled}
          key={item.id}
          onClick={() => {
            if (close("selection")) item.onSelect();
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
