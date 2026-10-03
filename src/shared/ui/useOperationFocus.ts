import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { isFocusAvailable } from "./focus";

interface FocusLease {
  context: string;
  owner: HTMLElement | null;
  valid: boolean;
}

interface OperationFocusOptions {
  context: string;
  ready: boolean;
  listRef: RefObject<HTMLElement | null>;
  findTarget: (key: string) => HTMLElement | null;
  onRestored?: (key: string) => void;
}

// Resolve operation results after React commits refreshed rows, never in a timer.
export function useOperationFocus(options: OperationFocusOptions) {
  const latest = useRef(options);
  const lease = useRef<FocusLease | null>(null);
  const pending = useRef<{ lease: FocusLease; keys: string[]; select: boolean } | null>(null);
  useLayoutEffect(() => { latest.current = options; });
  useLayoutEffect(() => {
    const invalidate = (event: Event) => {
      const current = lease.current;
      if (!current || !(event.target instanceof Node) || event.target === document.body || current.owner?.contains(event.target)) return;
      // Closing a dialog may temporarily return focus to its list while the
      // refreshed rows are still loading. Any other handoff cancels the request.
      if (event.type === "focusin" && pending.current && event.target === latest.current.listRef.current) return;
      current.valid = false;
    };
    document.addEventListener("focusin", invalidate);
    document.addEventListener("pointerdown", invalidate, true);
    return () => {
      document.removeEventListener("focusin", invalidate);
      document.removeEventListener("pointerdown", invalidate, true);
      if (lease.current) lease.current.valid = false;
      pending.current = null;
    };
  }, [options.context]);

  useLayoutEffect(() => {
    if (!isFocusAvailable(options.listRef.current)) {
      if (lease.current) lease.current.valid = false;
      pending.current = null;
      return;
    }
    const request = pending.current;
    if (!request || !options.ready) return;
    pending.current = null;
    const active = document.activeElement;
    if (!request.lease.valid || request.lease.context !== options.context || !isFocusAvailable(options.listRef.current)
      || (active && active !== document.body && active !== options.listRef.current && !request.lease.owner?.contains(active))) return;
    const key = request.keys.find((candidate) => isFocusAvailable(options.findTarget(candidate)));
    const target = key === undefined ? options.listRef.current : options.findTarget(key);
    target?.focus({ preventScroll: true });
    if (key !== undefined && request.select) options.onRestored?.(key);
    request.lease.valid = false;
  });

  const begin = useCallback((owner: HTMLElement | null, restore = true) => {
    if (lease.current) lease.current.valid = false;
    const next = { context: latest.current.context, owner, valid: restore };
    lease.current = next;
    pending.current = null;
    return next;
  }, []);
  const complete = useCallback((current: FocusLease | null, keys: string[], select = false) => {
    if (current?.valid && current === lease.current && current.context === latest.current.context) pending.current = { lease: current, keys, select };
  }, []);
  const isPending = useCallback(() => Boolean(pending.current), []);
  return { begin, complete, isPending };
}
