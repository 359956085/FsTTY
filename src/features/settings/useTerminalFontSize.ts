import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { clampTerminalFontSize, DEFAULT_TERMINAL_FONT_SIZE, isTerminalFontSize } from "../../shared/terminalFontSize";

// Lives at application scope: settings navigation and tab changes must not cancel a save.
export function useTerminalFontSize(onSaved: (size: number) => void) {
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const state = useRef({ desired: DEFAULT_TERMINAL_FONT_SIZE, saved: DEFAULT_TERMINAL_FONT_SIZE, revision: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pendingSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const persist = useCallback(async function persistLatest() {
    if (inFlight.current || !mounted.current || state.current.desired === state.current.saved) return;
    const { desired, revision } = state.current;
    inFlight.current = true;
    setSaving(true);
    try {
      pendingSave.current = api.setTerminalFontSize(desired).then(() => undefined);
      await pendingSave.current;
      state.current.saved = desired;
      if (mounted.current) onSavedRef.current(desired);
    } catch (nextError) {
      if (mounted.current && state.current.revision === revision) {
        state.current.desired = state.current.saved;
        setFontSize(state.current.saved);
        setError(nextError);
      }
    } finally {
      inFlight.current = false;
      pendingSave.current = null;
      if (mounted.current) {
        setSaving(false);
        if (timer.current === null && state.current.desired !== state.current.saved) void persistLatest();
      }
    }
  }, []);

  const change = useCallback((size: number, delay = 0) => {
    if (!isTerminalFontSize(size) || size === state.current.desired) return;
    state.current.desired = size;
    state.current.revision += 1;
    setFontSize(size);
    setError(null);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persist();
    }, delay);
  }, [persist]);

  const adjust = useCallback((steps: number) => {
    change(clampTerminalFontSize(state.current.desired + steps), 300);
  }, [change]);

  const initialize = useCallback((size: number) => {
    const value = isTerminalFontSize(size) ? size : DEFAULT_TERMINAL_FONT_SIZE;
    state.current.desired = value;
    state.current.saved = value;
    setFontSize(value);
  }, []);

  const flush = useCallback(async () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    while (mounted.current && (inFlight.current || state.current.desired !== state.current.saved)) {
      if (pendingSave.current) await pendingSave.current.catch(() => undefined);
      else await persist();
    }
  }, [persist]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return { fontSize, error, saving, change, adjust, initialize, flush };
}
