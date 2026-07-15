import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  CreateSessionPayload,
  Session,
  SessionGroup,
  UpdateSessionPayload,
} from "../../shared/api/types";
import {
  readWorkspacePreferences,
  updateWorkspacePreferences,
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

export function useSessionsPageState({
  confirmDeleteText,
  errorFallback,
}: UseSessionsPageStateOptions) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [favoriteSessionIds, setFavoriteSessionIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [collapsedGroupNames, setCollapsedGroupNames] = useState<string[]>([]);
  const [dialogState, setDialogState] = useState<SessionDialogState>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const initialized = useRef(false);
  const requestId = useRef(0);
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
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return openSessionIds.flatMap((sessionId) => {
      const session = byId.get(sessionId);
      return session ? [session] : [];
    });
  }, [openSessionIds, sessions]);

  const applyPreferences = useCallback(
    (
      nextOpenIds: string[],
      requestedActiveId: string | null,
      nextFavoriteIds: string[],
    ) => {
      const uniqueOpenIds = [...new Set(nextOpenIds)];
      const uniqueFavoriteIds = [...new Set(nextFavoriteIds)];
      const nextActiveId =
        requestedActiveId && uniqueOpenIds.includes(requestedActiveId)
          ? requestedActiveId
          : uniqueOpenIds[0] ?? null;
      openSessionIdsRef.current = uniqueOpenIds;
      activeSessionIdRef.current = nextActiveId;
      favoriteSessionIdsRef.current = uniqueFavoriteIds;
      setOpenSessionIds(uniqueOpenIds);
      setActiveSessionId(nextActiveId);
      setFavoriteSessionIds(uniqueFavoriteIds);
      updateWorkspacePreferences({
        tabs: { openSessionIds: uniqueOpenIds, activeSessionId: nextActiveId },
        favoriteSessionIds: uniqueFavoriteIds,
      });
    },
    [],
  );

  const refreshSessions = useCallback(async () => {
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    setLoading(true);
    setError(null);
    try {
      const nextGroups = await api.listSessions();
      if (requestId.current !== nextRequestId) {
        return;
      }
      const nextSessions = nextGroups.flatMap((group) => group.sessions);
      const validIds = new Set(nextSessions.map((session) => session.id));
      const preferences = initialized.current
        ? {
            tabs: {
              openSessionIds: openSessionIdsRef.current,
              activeSessionId: activeSessionIdRef.current,
            },
            favoriteSessionIds: favoriteSessionIdsRef.current,
          }
        : readWorkspacePreferences();
      const validOpenIds = preferences.tabs.openSessionIds.filter((id) =>
        validIds.has(id),
      );
      const validFavoriteIds = preferences.favoriteSessionIds.filter((id) =>
        validIds.has(id),
      );
      const validActiveId =
        preferences.tabs.activeSessionId &&
        validOpenIds.includes(preferences.tabs.activeSessionId)
          ? preferences.tabs.activeSessionId
          : validOpenIds[0] ?? null;
      initialized.current = true;
      setGroups(nextGroups);
      setCollapsedGroupNames((current) =>
        current.filter((name) => nextGroups.some((group) => group.name === name)),
      );
      applyPreferences(validOpenIds, validActiveId, validFavoriteIds);
    } catch (nextError) {
      if (requestId.current === nextRequestId) {
        setError(resolveApiError(nextError, errorFallback));
      }
    } finally {
      if (requestId.current === nextRequestId) {
        setLoading(false);
      }
    }
  }, [applyPreferences, errorFallback]);

  useEffect(() => {
    void refreshSessions();
    return () => {
      requestId.current += 1;
    };
  }, [refreshSessions]);

  const selectSession = useCallback(
    (sessionId: string) => {
      if (!sessions.some((session) => session.id === sessionId)) {
        return;
      }
      const nextOpenIds = openSessionIdsRef.current.includes(sessionId)
        ? openSessionIdsRef.current
        : [...openSessionIdsRef.current, sessionId];
      applyPreferences(nextOpenIds, sessionId, favoriteSessionIdsRef.current);
    },
    [applyPreferences, sessions],
  );

  const closeSessionTab = useCallback(
    (sessionId: string) => {
      const current = openSessionIdsRef.current;
      const index = current.indexOf(sessionId);
      if (index < 0) {
        return;
      }
      const nextOpenIds = current.filter((id) => id !== sessionId);
      const nextActiveId =
        activeSessionIdRef.current === sessionId
          ? nextOpenIds[index] ?? nextOpenIds[index - 1] ?? null
          : activeSessionIdRef.current;
      applyPreferences(nextOpenIds, nextActiveId, favoriteSessionIdsRef.current);
    },
    [applyPreferences],
  );

  const toggleFavorite = useCallback(
    (sessionId: string) => {
      if (!sessions.some((session) => session.id === sessionId)) {
        return;
      }
      const current = favoriteSessionIdsRef.current;
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId];
      applyPreferences(openSessionIdsRef.current, activeSessionIdRef.current, next);
    },
    [applyPreferences, sessions],
  );

  const toggleGroup = useCallback((groupName: string) => {
    setCollapsedGroupNames((current) =>
      current.includes(groupName)
        ? current.filter((name) => name !== groupName)
        : [...current, groupName],
    );
  }, []);

  async function saveSession(
    payload: CreateSessionPayload | UpdateSessionPayload,
  ) {
    setError(null);
    setSaveError(null);
    try {
      if ("id" in payload) {
        const updated = await api.updateSession(payload);
        setGroups((current) => upsertSessionInGroups(current, updated));
      } else {
        const created = await api.createSession(payload);
        setGroups((current) => upsertSessionInGroups(current, created));
        applyPreferences(
          [...openSessionIdsRef.current, created.id],
          created.id,
          favoriteSessionIdsRef.current,
        );
      }
      setDialogState(null);
      await refreshSessions();
    } catch (nextError) {
      // 保存失败时保留弹窗和输入，用户可修正后重试。
      const message = resolveApiError(nextError, errorFallback);
      setError(message);
      setSaveError(message);
    }
  }

  const changeDialogState = useCallback((next: SessionDialogState) => {
    setSaveError(null);
    setDialogState(next);
  }, []);

  async function deleteActiveSession() {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !window.confirm(confirmDeleteText)) {
      return null;
    }
    setError(null);
    try {
      await api.deleteSession(sessionId);
      const currentOpenIds = openSessionIdsRef.current;
      const deletedIndex = currentOpenIds.indexOf(sessionId);
      const nextOpenIds = currentOpenIds.filter((id) => id !== sessionId);
      const nextActiveId =
        nextOpenIds[deletedIndex] ?? nextOpenIds[deletedIndex - 1] ?? null;
      setGroups((current) =>
        current
          .map((group) => ({
            ...group,
            sessions: group.sessions.filter((session) => session.id !== sessionId),
          }))
          .filter((group) => group.sessions.length > 0),
      );
      applyPreferences(
        nextOpenIds,
        nextActiveId,
        favoriteSessionIdsRef.current.filter((id) => id !== sessionId),
      );
      return sessionId;
    } catch (nextError) {
      setError(resolveApiError(nextError, errorFallback));
      return null;
    }
  }

  return {
    activeSession,
    activeSessionId,
    closeSessionTab,
    collapsedGroupNames,
    deleteActiveSession,
    dialogState,
    error,
    favoriteSessionIds,
    filter,
    groups,
    loading,
    openSessions,
    query,
    refreshSessions,
    saveError,
    saveSession,
    selectSession,
    sessions,
    setDialogState: changeDialogState,
    setFilter,
    setQuery,
    toggleFavorite,
    toggleGroup,
  };
}

function upsertSessionInGroups(groups: SessionGroup[], session: Session) {
  const withoutSession = groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((current) => current.id !== session.id),
    }))
    .filter((group) => group.sessions.length > 0);
  const groupIndex = withoutSession.findIndex(
    (group) => group.name === session.group,
  );
  if (groupIndex < 0) {
    return [...withoutSession, { name: session.group, sessions: [session] }];
  }
  return withoutSession.map((group, index) =>
    index === groupIndex
      ? { ...group, sessions: [...group.sessions, session] }
      : group,
  );
}
