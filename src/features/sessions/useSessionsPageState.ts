import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  CreateSessionPayload,
  DeviceStatus,
  FileEntry,
  Session,
  SessionConnection,
  SessionGroup,
  UpdateSessionPayload,
} from "../../shared/api/types";
import { DEFAULT_REMOTE_PATH } from "./constants";

export type SessionDialogState =
  | { mode: "create"; session?: undefined }
  | { mode: "edit"; session: Session }
  | null;

interface UseSessionsPageStateOptions {
  confirmDeleteText: string;
  errorFallback: string;
}

export function useSessionsPageState({
  confirmDeleteText,
  errorFallback,
}: UseSessionsPageStateOptions) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [query, setQuery] = useState("");
  const [dialogState, setDialogState] = useState<SessionDialogState>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeRequestId = useRef(0);

  const sessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const handleError = useCallback(
    (nextError: unknown) => {
      setError(resolveApiError(nextError, errorFallback));
    },
    [errorFallback],
  );

  const clearSessionData = useCallback(() => {
    activeRequestId.current += 1;
    setConnection(null);
    setFiles([]);
    setDeviceStatus(null);
    setLoading(false);
  }, []);

  const loadSessions = useCallback(async () => {
    const nextGroups = await api.listSessions();
    const nextSessions = nextGroups.flatMap((group) => group.sessions);

    setGroups(nextGroups);
    setActiveSessionId((current) => {
      if (current && nextSessions.some((session) => session.id === current)) {
        return current;
      }

      return nextSessions[0]?.id ?? null;
    });
  }, []);

  const loadSessionData = useCallback(
    async (sessionId: string) => {
      const requestId = activeRequestId.current + 1;
      activeRequestId.current = requestId;
      setLoading(true);
      setError(null);

      try {
        const [nextConnection, nextFiles, nextDeviceStatus] = await Promise.all([
          api.openSession(sessionId),
          api.listRemoteFiles(sessionId, DEFAULT_REMOTE_PATH),
          api.getDeviceStatus(sessionId),
        ]);

        if (requestId !== activeRequestId.current) {
          return;
        }

        setConnection(nextConnection);
        setFiles(nextFiles);
        setDeviceStatus(nextDeviceStatus);
      } catch (nextError) {
        if (requestId !== activeRequestId.current) {
          return;
        }

        handleError(nextError);
      } finally {
        if (requestId === activeRequestId.current) {
          setLoading(false);
        }
      }
    },
    [handleError],
  );

  useEffect(() => {
    loadSessions().catch(handleError);
  }, [handleError, loadSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      clearSessionData();
      return;
    }

    clearSessionData();
    void loadSessionData(activeSessionId);

    return () => {
      // 会话切换或页面卸载后，旧请求结果不能再覆盖当前界面。
      activeRequestId.current += 1;
    };
  }, [activeSessionId, clearSessionData, loadSessionData]);

  const refreshActiveSession = useCallback(async () => {
    if (!activeSessionId || loading) {
      return;
    }

    await loadSessionData(activeSessionId);
  }, [activeSessionId, loadSessionData, loading]);

  async function saveSession(payload: CreateSessionPayload | UpdateSessionPayload) {
    setError(null);

    try {
      if ("id" in payload) {
        const updated = await api.updateSession(payload);
        await loadSessions();
        setActiveSessionId(updated.id);
      } else {
        const created = await api.createSession(payload);
        await loadSessions();
        setActiveSessionId(created.id);
      }

      setDialogState(null);
    } catch (nextError) {
      handleError(nextError);
    }
  }

  async function deleteActiveSession() {
    if (!activeSession || !window.confirm(confirmDeleteText)) {
      return;
    }

    const activeIndex = sessions.findIndex((session) => session.id === activeSession.id);
    const nextSession = sessions[activeIndex + 1] ?? sessions[activeIndex - 1] ?? null;

    setError(null);

    try {
      await api.deleteSession(activeSession.id);
      clearSessionData();
      setActiveSessionId(nextSession?.id ?? null);
      await loadSessions();
    } catch (nextError) {
      handleError(nextError);
    }
  }

  return {
    activeSession,
    activeSessionId,
    connection,
    deleteActiveSession,
    deviceStatus,
    dialogState,
    error,
    files,
    groups,
    loading,
    query,
    refreshActiveSession,
    saveSession,
    sessions,
    setActiveSessionId,
    setDialogState,
    setQuery,
  };
}
