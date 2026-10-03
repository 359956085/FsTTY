import { useCallback, useLayoutEffect, useRef } from "react";
import { isFocusAvailable as available } from "./focus";

interface DialogFocusOptions {
  open?: boolean;
  onClose: () => void;
  canClose?: boolean;
  initialFocus?: (dialog: HTMLElement) => HTMLElement | null;
  returnFocus?: () => HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
}

function tabStops(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>("*"))
    .filter((element) => element.tabIndex >= 0 && available(element))
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

interface FocusSession {
  nodes: Set<HTMLElement>;
  lastFocus: HTMLElement | null;
}

// The owner stays mounted across Suspense fallback/content changes. Registering a
// replacement container transfers focus without ending the dialog's lifecycle.
export function useDialogFocus(options: DialogFocusOptions) {
  const { open = true } = options;
  const optionsRef = useRef(options);
  const nodeRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<FocusSession | null>(null);

  useLayoutEffect(() => { optionsRef.current = options; });

  const requestClose = useCallback(() => {
    if (optionsRef.current.canClose !== false) optionsRef.current.onClose();
  }, []);

  const anotherDialogHasFocus = useCallback(() => {
    const activeDialog = document.activeElement?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]');
    return Boolean(activeDialog && !sessionRef.current?.nodes.has(activeDialog));
  }, []);

  const focusInitial = useCallback((node: HTMLElement) => {
    if (!available(node) || anotherDialogHasFocus()) return;
    const preferred = optionsRef.current.initialFocus?.(node);
    const target = preferred && node.contains(preferred) && available(preferred)
      ? preferred : tabStops(node)[0] ?? node;
    target.focus({ preventScroll: true });
  }, [anotherDialogHasFocus]);

  const dialogRef = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
    if (!node) return;
    const session = sessionRef.current;
    if (session) {
      session.nodes.add(node);
      focusInitial(node);
    }
    return () => {
      if (nodeRef.current === node) nodeRef.current = null;
    };
  }, [focusInitial]);

  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const session: FocusSession = { nodes: new Set(), lastFocus: null };
    sessionRef.current = session;
    const node = nodeRef.current;
    if (node) {
      session.nodes.add(node);
      focusInitial(node);
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = nodeRef.current;
      if (!dialog || !available(dialog) || anotherDialogHasFocus() || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      } else if (event.key === "Tab") {
        const stops = tabStops(dialog);
        const first = stops[0];
        const last = stops[stops.length - 1];
        const active = document.activeElement;
        if (!first || !last) {
          event.preventDefault();
          dialog.focus({ preventScroll: true });
        } else if (!dialog.contains(active) || active === dialog) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        // Let the browser advance from internal targets it makes focusable
        // itself (for example scroll containers with an implicit tab stop).
      }
    };
    const handleFocus = (event: FocusEvent) => {
      const dialog = nodeRef.current;
      if (!dialog || !available(dialog) || anotherDialogHasFocus()) return;
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) {
        session.lastFocus = event.target;
      } else if (session.lastFocus && dialog.contains(session.lastFocus) && available(session.lastFocus)) {
        session.lastFocus.focus({ preventScroll: true });
      } else {
        focusInitial(dialog);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocus);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocus);
      sessionRef.current = null;
      const active = document.activeElement;
      // A newly opened dialog or page may already own focus when we unmount.
      if (active && active !== document.body && !Array.from(session.nodes).some((root) => root.contains(active))) return;
      const target = optionsRef.current.returnFocus ? optionsRef.current.returnFocus() : previousFocus;
      const fallback = optionsRef.current.fallbackFocus?.();
      const restore = target && available(target) ? target : fallback && available(fallback) ? fallback : null;
      restore?.focus({ preventScroll: true });
    };
  }, [open, anotherDialogHasFocus, focusInitial, requestClose]);

  return { dialogRef, requestClose };
}
