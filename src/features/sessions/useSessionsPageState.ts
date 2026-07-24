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
import {
  renameSessionGroup as renameGroupInState,
  reorderSessionGroups,
  reorderSessionInGroups,
} from "./sessionOrdering";

export type SessionDialogState =
  | { mode: "create"; session?: undefined }
  | { mode: "edit"; session: Session }
  | null;

export type SessionFilter = "all" | "favorites";

interface SessionTabState {
  id: string;
  sessionId: string;
  autoConnect: boolean;
}

export interface OpenSessionTab extends SessionTabState {
  session: Session;
}

export type SessionListMutationResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: string };

interface UseSessionsPageStateOptions {
  confirmDeleteText: string;
  errorFallback: string;
}

export function useSessionsPageState({
  confirmDeleteText,
  errorFallback,
}: UseSessionsPageStateOptions) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<SessionTabState[]>([]);
  const [favoriteSessionIds, setFavoriteSessionIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [collapsedGroupNames, setCollapsedGroupNames] = useState<string[]>([]);
  const [dialogState, setDialogState] = useState<SessionDialogState>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listMutationPending, setListMutationPending] = useState(false);
  const initialized = useRef(false);
  const requestId = useRef(0);
  const groupsRef = useRef<SessionGroup[]>([]);
  const listMutationPendingRef = useRef(false);
  const activeTabIdRef = useRef<string | null>(null);
  const openTabsRef = useRef<SessionTabState[]>([]);
  const favoriteSessionIdsRef = useRef<string[]>([]);

  const sessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );
  const openSessionTabs = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return openTabs.flatMap((tab) => {
      const session = byId.get(tab.sessionId);
      return session ? [{ ...tab, session }] : [];
    });
  }, [openTabs, sessions]);

  const applyPreferences = useCallback(
    (
      nextTabs: SessionTabState[],
      requestedActiveTabId: string | null,
      nextFavoriteIds: string[],
    ) => {
      const seen = new Set<string>();
      const uniqueTabs = nextTabs.filter((tab) => {
        if (seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
      });
      const uniqueFavoriteIds = [...new Set(nextFavoriteIds)];
      const nextActiveTabId =
        requestedActiveTabId && uniqueTabs.some((tab) => tab.id === requestedActiveTabId)
          ? requestedActiveTabId
          : uniqueTabs[0]?.id ?? null;
      openTabsRef.current = uniqueTabs;
      activeTabIdRef.current = nextActiveTabId;
      favoriteSessionIdsRef.current = uniqueFavoriteIds;
      setOpenTabs(uniqueTabs);
      setActiveTabId(nextActiveTabId);
      setFavoriteSessionIds(uniqueFavoriteIds);
      updateWorkspacePreferences({
        tabs: {
          openTabs: uniqueTabs.map(({ id, sessionId }) => ({ id, sessionId })),
          activeTabId: nextActiveTabId,
        },
        favoriteSessionIds: uniqueFavoriteIds,
      });
    },
    [],
  );

  const refreshSessions = useCallback(async () => {
    if (listMutationPendingRef.current) return;
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    setLoading(true);
    setError(null);
    try {
      const nextGroups = await api.listSessions();
      if (requestId.current !== nextRequestId) return;
      const nextSessions = nextGroups.flatMap((group) => group.sessions);
      const validIds = new Set(nextSessions.map((session) => session.id));
      const stored = initialized.current ? null : readWorkspacePreferences();
      const candidateTabs = initialized.current
        ? openTabsRef.current
        : (stored?.tabs.openTabs ?? []).map((tab) => ({ ...tab, autoConnect: false }));
      const validTabs = candidateTabs.filter((tab) => validIds.has(tab.sessionId));
      const candidateActiveTabId = initialized.current
        ? activeTabIdRef.current
        : stored?.tabs.activeTabId ?? null;
      const candidateFavoriteIds = initialized.current
        ? favoriteSessionIdsRef.current
        : stored?.favoriteSessionIds ?? [];
      const validFavoriteIds = candidateFavoriteIds.filter((id) => validIds.has(id));
      initialized.current = true;
      groupsRef.current = nextGroups;
      setGroups(nextGroups);
      setSelectedSessionId((current) => {
        return current && validIds.has(current) ? current : null;
      });
      setCollapsedGroupNames((current) =>
        current.filter((name) => nextGroups.some((group) => group.name === name)),
      );
      applyPreferences(validTabs, candidateActiveTabId, validFavoriteIds);
    } catch (nextError) {
      if (requestId.current === nextRequestId) {
        setError(resolveApiError(nextError, errorFallback));
      }
    } finally {
      if (requestId.current === nextRequestId) setLoading(false);
    }
  }, [applyPreferences, errorFallback]);

  useEffect(() => {
    void refreshSessions();
    return () => {
      requestId.current += 1;
    };
  }, [refreshSessions]);

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
  }, []);

  const openSessionTab = useCallback(
    (sessionId: string, autoConnect = true) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      const tab: SessionTabState = {
        id: crypto.randomUUID(),
        sessionId,
        autoConnect:
          autoConnect &&
          Boolean(session.username.trim()) &&
          session.credentialState !== "missing",
      };
      applyPreferences([...openTabsRef.current, tab], tab.id, favoriteSessionIdsRef.current);
    },
    [applyPreferences, sessions],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      applyPreferences(openTabsRef.current, tabId, favoriteSessionIdsRef.current);
    },
    [applyPreferences],
  );

  const closeSessionTab = useCallback(
    (tabId: string) => {
      const current = openTabsRef.current;
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const nextTabs = current.filter((tab) => tab.id !== tabId);
      const nextActiveTabId =
        activeTabIdRef.current === tabId
          ? nextTabs[index]?.id ?? nextTabs[index - 1]?.id ?? null
          : activeTabIdRef.current;
      applyPreferences(nextTabs, nextActiveTabId, favoriteSessionIdsRef.current);
    },
    [applyPreferences],
  );

  const toggleFavorite = useCallback(
    (sessionId: string) => {
      if (!sessions.some((session) => session.id === sessionId)) return;
      const current = favoriteSessionIdsRef.current;
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId];
      applyPreferences(openTabsRef.current, activeTabIdRef.current, next);
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

  const beginListMutation = useCallback(() => {
    if (listMutationPendingRef.current) return false;
    listMutationPendingRef.current = true;
    requestId.current += 1;
    setLoading(false);
    setListMutationPending(true);
    setError(null);
    return true;
  }, []);

  const finishListMutation = useCallback(() => {
    listMutationPendingRef.current = false;
    setListMutationPending(false);
  }, []);

  const reorderGroup = useCallback(
    async (groupName: string, targetIndex: number) => {
      if (!beginListMutation()) return false;
      const previous = groupsRef.current;
      const next = reorderSessionGroups(previous, groupName, targetIndex);
      if (next === previous) {
        finishListMutation();
        return true;
      }
      groupsRef.current = next;
      setGroups(next);
      try {
        await api.reorderSessionGroup(groupName, targetIndex);
        return true;
      } catch (nextError) {
        groupsRef.current = previous;
        setGroups(previous);
        setError(resolveApiError(nextError, errorFallback));
        return false;
      } finally {
        finishListMutation();
      }
    },
    [beginListMutation, errorFallback, finishListMutation],
  );

  const reorderSession = useCallback(
    async (
      sessionId: string,
      targetGroupName: string,
      targetIndex: number,
    ) => {
      if (!beginListMutation()) return false;
      const previous = groupsRef.current;
      const next = reorderSessionInGroups(
        previous,
        sessionId,
        targetGroupName,
        targetIndex,
      );
      if (next === previous) {
        finishListMutation();
        return true;
      }
      groupsRef.current = next;
      setGroups(next);
      try {
        await api.reorderSession(sessionId, targetGroupName, targetIndex);
        return true;
      } catch (nextError) {
        groupsRef.current = previous;
        setGroups(previous);
        setError(resolveApiError(nextError, errorFallback));
        return false;
      } finally {
        finishListMutation();
      }
    },
    [beginListMutation, errorFallback, finishListMutation],
  );

  const renameGroup = useCallback(
    async (groupName: string, newName: string) => {
      if (!beginListMutation()) {
        return {
          ok: false,
          error: errorFallback,
        } satisfies SessionListMutationResult;
      }
      const normalizedName = newName.trim();
      const previous = groupsRef.current;
      const previousCollapsed = collapsedGroupNames;
      const next = renameGroupInState(previous, groupName, normalizedName);
      groupsRef.current = next;
      setGroups(next);
      setCollapsedGroupNames((current) =>
        current.map((name) => (name === groupName ? normalizedName : name)),
      );
      try {
        await api.renameSessionGroup(groupName, normalizedName);
        return { ok: true, value: undefined } satisfies SessionListMutationResult;
      } catch (nextError) {
        const message = resolveApiError(nextError, errorFallback);
        groupsRef.current = previous;
        setGroups(previous);
        setCollapsedGroupNames(previousCollapsed);
        setError(message);
        return { ok: false, error: message } satisfies SessionListMutationResult;
      } finally {
        finishListMutation();
      }
    },
    [
      beginListMutation,
      collapsedGroupNames,
      errorFallback,
      finishListMutation,
    ],
  );

  const deleteGroup = useCallback(
    async (groupName: string) => {
      if (!beginListMutation()) {
        return {
          ok: false,
          error: errorFallback,
        } satisfies SessionListMutationResult<string[]>;
      }
      try {
        const deletedIds = await api.deleteSessionGroup(groupName);
        const deletedSet = new Set(deletedIds);
        const nextGroups = groupsRef.current.filter(
          (group) => group.name !== groupName,
        );
        groupsRef.current = nextGroups;
        setGroups(nextGroups);
        setCollapsedGroupNames((current) =>
          current.filter((name) => name !== groupName),
        );
        setSelectedSessionId((current) =>
          current && deletedSet.has(current) ? null : current,
        );

        const currentTabs = openTabsRef.current;
        const nextTabs = currentTabs.filter(
          (tab) => !deletedSet.has(tab.sessionId),
        );
        const activeWasDeleted = currentTabs.some(
          (tab) =>
            tab.id === activeTabIdRef.current &&
            deletedSet.has(tab.sessionId),
        );
        const nextActiveTabId = activeWasDeleted
          ? nextTabs[0]?.id ?? null
          : activeTabIdRef.current;
        applyPreferences(
          nextTabs,
          nextActiveTabId,
          favoriteSessionIdsRef.current.filter((id) => !deletedSet.has(id)),
        );
        return {
          ok: true,
          value: deletedIds,
        } satisfies SessionListMutationResult<string[]>;
      } catch (nextError) {
        const message = resolveApiError(nextError, errorFallback);
        setError(message);
        return {
          ok: false,
          error: message,
        } satisfies SessionListMutationResult<string[]>;
      } finally {
        finishListMutation();
      }
    },
    [
      applyPreferences,
      beginListMutation,
      errorFallback,
      finishListMutation,
    ],
  );

  async function saveSession(payload: CreateSessionPayload | UpdateSessionPayload) {
    setError(null);
    setSaveError(null);
    try {
      if ("id" in payload) {
        const updated = await api.updateSession(payload);
        setGroups((current) => {
          const next = upsertSessionInGroups(current, updated);
          groupsRef.current = next;
          return next;
        });
      } else {
        const created = await api.createSession(payload);
        setGroups((current) => {
          const next = upsertSessionInGroups(current, created);
          groupsRef.current = next;
          return next;
        });
        setSelectedSessionId(created.id);
        const tab: SessionTabState = {
          id: crypto.randomUUID(),
          sessionId: created.id,
          autoConnect:
            Boolean(created.username.trim()) && created.credentialState !== "missing",
        };
        applyPreferences([...openTabsRef.current, tab], tab.id, favoriteSessionIdsRef.current);
      }
      setDialogState(null);
      await refreshSessions();
    } catch (nextError) {
      const message = resolveApiError(nextError, errorFallback);
      setError(message);
      setSaveError(message);
    }
  }

  const changeDialogState = useCallback((next: SessionDialogState) => {
    setSaveError(null);
    setDialogState(next);
  }, []);

  async function deleteSession(sessionId: string) {
    if (!window.confirm(confirmDeleteText)) return null;
    setError(null);
    try {
      await api.deleteSession(sessionId);
      const currentTabs = openTabsRef.current;
      const removedIndexes = currentTabs
        .map((tab, index) => (tab.sessionId === sessionId ? index : -1))
        .filter((index) => index >= 0);
      const nextTabs = currentTabs.filter((tab) => tab.sessionId !== sessionId);
      const firstRemovedIndex = removedIndexes[0] ?? 0;
      const nextActiveTabId = currentTabs.some(
        (tab) => tab.id === activeTabIdRef.current && tab.sessionId === sessionId,
      )
        ? nextTabs[firstRemovedIndex]?.id ?? nextTabs[firstRemovedIndex - 1]?.id ?? null
        : activeTabIdRef.current;
      setGroups((current) =>
        {
          const next = current
          .map((group) => ({
            ...group,
            sessions: group.sessions.filter((session) => session.id !== sessionId),
          }))
          .filter((group) => group.sessions.length > 0);
          groupsRef.current = next;
          return next;
        },
      );
      setSelectedSessionId((current) => (current === sessionId ? null : current));
      applyPreferences(
        nextTabs,
        nextActiveTabId,
        favoriteSessionIdsRef.current.filter((id) => id !== sessionId),
      );
      return sessionId;
    } catch (nextError) {
      setError(resolveApiError(nextError, errorFallback));
      return null;
    }
  }

  return {
    activeTabId,
    closeSessionTab,
    collapsedGroupNames,
    deleteSession,
    dialogState,
    error,
    favoriteSessionIds,
    filter,
    groups,
    listMutationPending,
    loading,
    openSessionTab,
    openSessionTabs,
    query,
    refreshSessions,
    renameGroup,
    reorderGroup,
    reorderSession,
    saveError,
    saveSession,
    selectSession,
    selectTab,
    selectedSessionId,
    sessions,
    setDialogState: changeDialogState,
    setFilter,
    setQuery,
    toggleFavorite,
    toggleGroup,
    deleteGroup,
  };
}

function upsertSessionInGroups(groups: SessionGroup[], session: Session) {
  const withoutSession = groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((current) => current.id !== session.id),
    }))
    .filter((group) => group.sessions.length > 0);
  const groupIndex = withoutSession.findIndex((group) => group.name === session.group);
  if (groupIndex < 0) {
    return [...withoutSession, { name: session.group, sessions: [session] }];
  }
  return withoutSession.map((group, index) =>
    index === groupIndex
      ? { ...group, sessions: [...group.sessions, session] }
      : group,
  );
}
