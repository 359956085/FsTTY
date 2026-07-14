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
import {
  readWorkspacePreferences,
  updateWorkspacePreferences,
  WORKSPACE_STORAGE_KEY,
} from "./workspacePreferences";

export type SessionDialogState =
  | { mode: "create"; session?: undefined }
  | { mode: "edit"; session: Session }
  | null;

export type SessionFilter = "all" | "online" | "offline" | "favorites";

interface UseSessionsPageStateOptions {
  confirmDeleteText: string;
  errorFallback: string;
}

const DEFAULT_OPEN_SESSION_IDS = [
  "prod-web-01",
  "prod-db-01",
  "test-web-01",
] as const;

export function useSessionsPageState({
  confirmDeleteText,
  errorFallback,
}: UseSessionsPageStateOptions) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [favoriteSessionIds, setFavoriteSessionIds] = useState<string[]>([]);
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [currentPath, setCurrentPath] = useState(DEFAULT_REMOTE_PATH);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [collapsedGroupNames, setCollapsedGroupNames] = useState<string[]>([]);
  const [dialogState, setDialogState] = useState<SessionDialogState>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const hadStoredPreferencesOnMount = useRef(hasStoredWorkspacePreferences());
  const sessionsInitialized = useRef(false);
  const sessionsRequestId = useRef(0);
  const activeRequestId = useRef(0);
  const filesRequestId = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const openSessionIdsRef = useRef<string[]>([]);
  const favoriteSessionIdsRef = useRef<string[]>([]);

  const sessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const openSessions = useMemo(() => {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    return openSessionIds.flatMap((sessionId) => {
      const session = sessionsById.get(sessionId);
      return session ? [session] : [];
    });
  }, [openSessionIds, sessions]);

  const handleError = useCallback(
    (nextError: unknown) => {
      setError(resolveApiError(nextError, errorFallback));
    },
    [errorFallback],
  );

  const clearSessionData = useCallback(() => {
    activeRequestId.current += 1;
    filesRequestId.current += 1;
    setConnection(null);
    setFiles([]);
    setDeviceStatus(null);
    setLoading(false);
    setFilesLoading(false);
  }, []);

  const applySessionPreferences = useCallback(
    (
      nextOpenSessionIds: string[],
      nextActiveSessionId: string | null,
      nextFavoriteSessionIds: string[],
    ) => {
      const uniqueOpenIds = [...new Set(nextOpenSessionIds)];
      const uniqueFavoriteIds = [...new Set(nextFavoriteSessionIds)];
      const validActiveId =
        nextActiveSessionId && uniqueOpenIds.includes(nextActiveSessionId)
          ? nextActiveSessionId
          : uniqueOpenIds[0] ?? null;

      openSessionIdsRef.current = uniqueOpenIds;
      activeSessionIdRef.current = validActiveId;
      favoriteSessionIdsRef.current = uniqueFavoriteIds;
      setOpenSessionIds(uniqueOpenIds);
      setActiveSessionIdState(validActiveId);
      setFavoriteSessionIds(uniqueFavoriteIds);
      // 只更新会话区域，布局偏好由布局 Hook 独立维护。
      updateWorkspacePreferences({
        tabs: {
          openSessionIds: uniqueOpenIds,
          activeSessionId: validActiveId,
        },
        favoriteSessionIds: uniqueFavoriteIds,
      });
    },
    [],
  );

  const refreshSessions = useCallback(async () => {
    const requestId = sessionsRequestId.current + 1;
    sessionsRequestId.current = requestId;
    setError(null);

    try {
      const nextGroups = await api.listSessions();
      if (requestId !== sessionsRequestId.current) {
        return;
      }

      const nextSessions = nextGroups.flatMap((group) => group.sessions);
      const validIds = new Set(nextSessions.map((session) => session.id));
      let requestedOpenIds = openSessionIdsRef.current;
      let requestedActiveId = activeSessionIdRef.current;
      let requestedFavoriteIds = favoriteSessionIdsRef.current;

      if (!sessionsInitialized.current) {
        const preferences = readWorkspacePreferences();
        requestedOpenIds = preferences.tabs.openSessionIds;
        requestedActiveId = preferences.tabs.activeSessionId;
        requestedFavoriteIds = preferences.favoriteSessionIds;
      }

      let nextOpenIds = requestedOpenIds.filter((sessionId) => validIds.has(sessionId));
      // 只有从未保存过工作区时使用设计稿默认项；用户主动关空后重启仍保持空。
      if (
        !sessionsInitialized.current &&
        !hadStoredPreferencesOnMount.current &&
        nextOpenIds.length === 0
      ) {
        nextOpenIds = DEFAULT_OPEN_SESSION_IDS.filter((sessionId) => validIds.has(sessionId));
        if (nextOpenIds.length === 0) {
          nextOpenIds = nextSessions.slice(0, 3).map((session) => session.id);
        }
      }

      const nextActiveId =
        requestedActiveId && nextOpenIds.includes(requestedActiveId)
          ? requestedActiveId
          : nextOpenIds[0] ?? null;
      const nextFavoriteIds = requestedFavoriteIds.filter((sessionId) =>
        validIds.has(sessionId),
      );

      if (activeSessionIdRef.current !== nextActiveId) {
        clearSessionData();
        setCurrentPath(DEFAULT_REMOTE_PATH);
      }

      sessionsInitialized.current = true;
      setGroups(nextGroups);
      setCollapsedGroupNames((current) =>
        current.filter((groupName) =>
          nextGroups.some((group) => group.name === groupName),
        ),
      );
      applySessionPreferences(nextOpenIds, nextActiveId, nextFavoriteIds);
    } catch (nextError) {
      if (requestId === sessionsRequestId.current) {
        handleError(nextError);
      }
    }
  }, [applySessionPreferences, clearSessionData, handleError]);

  const loadSessionData = useCallback(
    async (sessionId: string) => {
      const requestId = activeRequestId.current + 1;
      activeRequestId.current = requestId;
      setLoading(true);

      try {
        const [nextConnection, nextDeviceStatus] = await Promise.all([
          api.openSession(sessionId),
          api.getDeviceStatus(sessionId),
        ]);

        if (requestId !== activeRequestId.current) {
          return;
        }

        setConnection(nextConnection);
        setDeviceStatus(nextDeviceStatus);
      } catch (nextError) {
        if (requestId === activeRequestId.current) {
          handleError(nextError);
        }
      } finally {
        if (requestId === activeRequestId.current) {
          setLoading(false);
        }
      }
    },
    [handleError],
  );

  const loadFiles = useCallback(
    async (sessionId: string, path: string) => {
      const requestId = filesRequestId.current + 1;
      filesRequestId.current = requestId;
      setFilesLoading(true);

      try {
        const nextFiles = await api.listRemoteFiles(sessionId, path);
        if (requestId === filesRequestId.current) {
          setFiles(nextFiles);
        }
      } catch (nextError) {
        if (requestId === filesRequestId.current) {
          handleError(nextError);
        }
      } finally {
        if (requestId === filesRequestId.current) {
          setFilesLoading(false);
        }
      }
    },
    [handleError],
  );

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      clearSessionData();
      return;
    }

    clearSessionData();
    setError(null);
    setCurrentPath(DEFAULT_REMOTE_PATH);
    void loadSessionData(activeSessionId);
    void loadFiles(activeSessionId, DEFAULT_REMOTE_PATH);

    return () => {
      // 会话切换或页面卸载后，旧响应不能覆盖新会话。
      activeRequestId.current += 1;
      filesRequestId.current += 1;
    };
  }, [activeSessionId, clearSessionData, loadFiles, loadSessionData]);

  const selectSession = useCallback(
    (sessionId: string) => {
      if (!sessions.some((session) => session.id === sessionId)) {
        return;
      }

      const nextOpenIds = openSessionIdsRef.current.includes(sessionId)
        ? openSessionIdsRef.current
        : [...openSessionIdsRef.current, sessionId];

      if (activeSessionIdRef.current !== sessionId) {
        clearSessionData();
        setCurrentPath(DEFAULT_REMOTE_PATH);
      }

      applySessionPreferences(
        nextOpenIds,
        sessionId,
        favoriteSessionIdsRef.current,
      );
    },
    [applySessionPreferences, clearSessionData, sessions],
  );

  const closeSessionTab = useCallback(
    (sessionId: string) => {
      const currentOpenIds = openSessionIdsRef.current;
      const closedIndex = currentOpenIds.indexOf(sessionId);
      if (closedIndex < 0) {
        return;
      }

      const nextOpenIds = currentOpenIds.filter((id) => id !== sessionId);
      const nextActiveId =
        activeSessionIdRef.current === sessionId
          ? nextOpenIds[closedIndex] ?? nextOpenIds[closedIndex - 1] ?? null
          : activeSessionIdRef.current;

      if (activeSessionIdRef.current !== nextActiveId) {
        clearSessionData();
        setCurrentPath(DEFAULT_REMOTE_PATH);
      }

      applySessionPreferences(
        nextOpenIds,
        nextActiveId,
        favoriteSessionIdsRef.current,
      );
    },
    [applySessionPreferences, clearSessionData],
  );

  const toggleFavorite = useCallback(
    (sessionId: string) => {
      if (!sessions.some((session) => session.id === sessionId)) {
        return;
      }

      const currentFavoriteIds = favoriteSessionIdsRef.current;
      const nextFavoriteIds = currentFavoriteIds.includes(sessionId)
        ? currentFavoriteIds.filter((id) => id !== sessionId)
        : [...currentFavoriteIds, sessionId];

      applySessionPreferences(
        openSessionIdsRef.current,
        activeSessionIdRef.current,
        nextFavoriteIds,
      );
    },
    [applySessionPreferences, sessions],
  );

  const toggleGroup = useCallback((groupName: string) => {
    setCollapsedGroupNames((current) =>
      current.includes(groupName)
        ? current.filter((name) => name !== groupName)
        : [...current, groupName],
    );
  }, []);

  const openPath = useCallback(
    (path: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      const nextPath = normalizeRemotePath(path);
      filesRequestId.current += 1;
      setCurrentPath(nextPath);
      setFiles([]);
      setError(null);
      void loadFiles(sessionId, nextPath);
    },
    [loadFiles],
  );

  const refreshFiles = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    setError(null);
    void loadFiles(sessionId, currentPath);
  }, [currentPath, loadFiles]);

  const refreshActiveSession = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || loading || filesLoading) {
      return;
    }

    clearSessionData();
    setError(null);
    await Promise.all([
      loadSessionData(sessionId),
      loadFiles(sessionId, currentPath),
    ]);
  }, [clearSessionData, currentPath, filesLoading, loadFiles, loadSessionData, loading]);

  async function saveSession(payload: CreateSessionPayload | UpdateSessionPayload) {
    setError(null);

    try {
      if ("id" in payload) {
        const updated = await api.updateSession(payload);
        setGroups((current) => upsertSessionInGroups(current, updated));
        setConnection((current) =>
          current?.session.id === updated.id
            ? { ...current, session: updated }
            : current,
        );
        await refreshSessions();
      } else {
        const created = await api.createSession(payload);
        setGroups((current) => upsertSessionInGroups(current, created));
        clearSessionData();
        setCurrentPath(DEFAULT_REMOTE_PATH);
        applySessionPreferences(
          openSessionIdsRef.current.includes(created.id)
            ? openSessionIdsRef.current
            : [...openSessionIdsRef.current, created.id],
          created.id,
          favoriteSessionIdsRef.current,
        );
        await refreshSessions();
      }

      setDialogState(null);
    } catch (nextError) {
      // 保存失败不关闭弹窗，用户可修正后重试。
      handleError(nextError);
    }
  }

  async function deleteActiveSession() {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !activeSession || !window.confirm(confirmDeleteText)) {
      return;
    }

    setError(null);

    try {
      await api.deleteSession(sessionId);

      const currentOpenIds = openSessionIdsRef.current;
      const deletedIndex = currentOpenIds.indexOf(sessionId);
      const nextOpenIds = currentOpenIds.filter((id) => id !== sessionId);
      const nextActiveId =
        nextOpenIds[deletedIndex] ?? nextOpenIds[deletedIndex - 1] ?? null;
      const nextFavoriteIds = favoriteSessionIdsRef.current.filter(
        (id) => id !== sessionId,
      );

      clearSessionData();
      setCurrentPath(DEFAULT_REMOTE_PATH);
      setGroups((current) =>
        current
          .map((group) => ({
            ...group,
            sessions: group.sessions.filter((session) => session.id !== sessionId),
          }))
          .filter((group) => group.sessions.length > 0),
      );
      applySessionPreferences(nextOpenIds, nextActiveId, nextFavoriteIds);
      await refreshSessions();
    } catch (nextError) {
      // 删除失败前不修改本地数据，避免界面与后端状态分叉。
      handleError(nextError);
    }
  }

  return {
    activeSession,
    activeSessionId,
    closeSessionTab,
    collapsedGroupNames,
    connection,
    currentPath,
    deleteActiveSession,
    deviceStatus,
    dialogState,
    error,
    favoriteSessionIds,
    files,
    filesLoading,
    filter,
    groups,
    loading,
    openPath,
    openSessions,
    query,
    refreshActiveSession,
    refreshFiles,
    refreshSessions,
    saveSession,
    selectSession,
    setDialogState,
    setFilter,
    setQuery,
    toggleFavorite,
    toggleGroup,
  };
}

function hasStoredWorkspacePreferences() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!stored) {
      return false;
    }

    const value = JSON.parse(stored) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }

    const tabs = (value as Record<string, unknown>).tabs;
    return (
      typeof tabs === "object" &&
      tabs !== null &&
      !Array.isArray(tabs) &&
      Array.isArray((tabs as Record<string, unknown>).openSessionIds)
    );
  } catch {
    return false;
  }
}

function normalizeRemotePath(path: string) {
  const segments: string[] = [];

  for (const segment of path.trim().replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return `/${segments.join("/")}`;
}

function upsertSessionInGroups(groups: SessionGroup[], session: Session) {
  const groupsWithoutSession = groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((current) => current.id !== session.id),
    }))
    .filter((group) => group.sessions.length > 0);
  const groupIndex = groupsWithoutSession.findIndex(
    (group) => group.name === session.group,
  );
  if (groupIndex < 0) {
    return [...groupsWithoutSession, { name: session.group, sessions: [session] }];
  }

  return groupsWithoutSession.map((group, index) =>
    index === groupIndex
      ? { ...group, sessions: [...group.sessions, session] }
      : group,
  );
}
