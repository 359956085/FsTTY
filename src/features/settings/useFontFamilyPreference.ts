import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import type { FontFamilyPreference } from "../../shared/api/types";
import { isFontFamily } from "../../shared/fonts";

export function useFontFamilyPreference(onSaved: (value: FontFamilyPreference) => void) {
  const [preference, setPreference] = useState<FontFamilyPreference>("default");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const state = useRef({ desired: "default" as FontFamilyPreference, saved: "default" as FontFamilyPreference, revision: 0 });
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const persist = useCallback(() => {
    if (pending.current) return pending.current;
    const task = (async () => {
      setSaving(true);
      while (mounted.current && state.current.desired !== state.current.saved) {
        const { desired, revision } = state.current;
        try {
          await api.setFontFamily(desired);
          state.current.saved = desired;
          if (mounted.current) savedRef.current(desired);
        } catch (nextError) {
          if (mounted.current && state.current.revision === revision) {
            state.current.desired = state.current.saved;
            setPreference(state.current.saved);
            setError(nextError);
          }
        }
      }
    })();
    pending.current = task.finally(() => {
      pending.current = null;
      if (mounted.current) setSaving(false);
    });
    return pending.current;
  }, []);

  const change = useCallback((value: FontFamilyPreference) => {
    if (!isFontFamily(value) || state.current.desired === value) return;
    state.current.desired = value;
    state.current.revision += 1;
    setPreference(value);
    setError(null);
    void persist();
  }, [persist]);

  const initialize = useCallback((value: FontFamilyPreference) => {
    const normalized = isFontFamily(value) ? value : "default";
    state.current.desired = normalized;
    state.current.saved = normalized;
    setPreference(normalized);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return { preference, change, initialize, saving, error, flush: persist };
}
