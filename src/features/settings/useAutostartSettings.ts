import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import { createLatestRequestGuard } from "../../shared/async/latestRequest";

export function useAutostartSettings(translate: (key: string) => string) {
  const [enabled, setEnabled] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(createLatestRequestGuard());
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const translateRef = useRef(translate);

  useEffect(() => {
    translateRef.current = translate;
  }, [translate]);

  const refresh = useCallback(async (preserveError = false) => {
    if (!mountedRef.current) return;
    if (savingRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    const requestId = requestRef.current.begin();
    setLoading(true);
    if (!preserveError) setError(null);
    try {
      const actual = await api.getAutostartState();
      if (!requestRef.current.isCurrent(requestId)) return;
      setEnabled((current) => requestRef.current.isCurrent(requestId) ? actual : current);
      setConfirmed(true);
    } catch (nextError) {
      if (!requestRef.current.isCurrent(requestId)) return;
      setConfirmed(false);
      const message = resolveApiError(nextError, translateRef.current("settings.autostartLoadFailed"));
      setError((current) => preserveError && current ? current : message);
    } finally {
      if (requestRef.current.isCurrent(requestId)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    savingRef.current = false;
    setSaving(false);
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const requests = requestRef.current;
    return () => {
      mountedRef.current = false;
      requests.invalidate();
      refreshPendingRef.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const save = useCallback(async (nextEnabled: boolean) => {
    if (!mountedRef.current || savingRef.current) return;
    const requestId = requestRef.current.begin();
    savingRef.current = true;
    setSaving(true);
    setLoading(false);
    setError(null);
    let failed = false;
    try {
      const actual = await api.setAutostartEnabled(nextEnabled);
      if (!requestRef.current.isCurrent(requestId)) return;
      setEnabled((current) => requestRef.current.isCurrent(requestId) ? actual : current);
      setConfirmed(true);
    } catch (nextError) {
      if (!requestRef.current.isCurrent(requestId)) return;
      failed = true;
      setError(resolveApiError(nextError, translateRef.current("settings.autostartSaveFailed")));
      // 系统可能只完成了部分写入，不能直接把开关回滚成旧的布尔值。
      try {
        const actual = await api.getAutostartState();
        if (!requestRef.current.isCurrent(requestId)) return;
        setEnabled((current) => requestRef.current.isCurrent(requestId) ? actual : current);
        setConfirmed(true);
      } catch {
        if (requestRef.current.isCurrent(requestId)) setConfirmed(false);
      }
    } finally {
      if (requestRef.current.isCurrent(requestId)) {
        savingRef.current = false;
        setSaving(false);
        if (refreshPendingRef.current) {
          refreshPendingRef.current = false;
          // 排队的聚焦刷新不能立即抹掉刚刚产生的保存错误。
          void refresh(failed);
        }
      }
    }
  }, [refresh]);

  return { confirmed, enabled, error, loading, refresh, save, saving };
}
