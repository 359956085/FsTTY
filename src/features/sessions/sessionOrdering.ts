import type { SessionGroup } from "../../shared/api/types";

export function reorderSessionGroups(
  groups: SessionGroup[],
  groupName: string,
  targetIndex: number,
) {
  const sourceIndex = groups.findIndex((group) => group.name === groupName);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= groups.length) {
    return groups;
  }
  if (sourceIndex === targetIndex) {
    return groups;
  }
  const next = [...groups];
  const [group] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, group);
  return next;
}

export function reorderSessionInGroups(
  groups: SessionGroup[],
  sessionId: string,
  targetGroupName: string,
  targetIndex: number,
) {
  const sourceGroupIndex = groups.findIndex((group) =>
    group.sessions.some((session) => session.id === sessionId),
  );
  const originalTargetGroup = groups.find((group) => group.name === targetGroupName);
  if (sourceGroupIndex < 0 || !originalTargetGroup || targetIndex < 0) {
    return groups;
  }

  const next = groups.map((group) => ({ ...group, sessions: [...group.sessions] }));
  const sourceGroup = next[sourceGroupIndex];
  const sourceSessionIndex = sourceGroup.sessions.findIndex(
    (session) => session.id === sessionId,
  );
  if (
    sourceGroup.name === targetGroupName &&
    sourceSessionIndex === targetIndex
  ) {
    return groups;
  }
  const [session] = sourceGroup.sessions.splice(sourceSessionIndex, 1);
  if (sourceGroup.sessions.length === 0) {
    next.splice(sourceGroupIndex, 1);
  }

  let targetGroup = next.find((group) => group.name === targetGroupName);
  if (!targetGroup && sourceGroup.name === targetGroupName) {
    targetGroup = { ...sourceGroup, sessions: [] };
    next.splice(Math.min(sourceGroupIndex, next.length), 0, targetGroup);
  }
  if (!targetGroup || targetIndex > targetGroup.sessions.length) {
    return groups;
  }
  targetGroup.sessions.splice(targetIndex, 0, {
    ...session,
    group: targetGroupName,
  });
  return next;
}

export function renameSessionGroup(
  groups: SessionGroup[],
  groupName: string,
  newName: string,
) {
  return groups.map((group) =>
    group.name === groupName
      ? {
          name: newName,
          sessions: group.sessions.map((session) => ({
            ...session,
            group: newName,
          })),
        }
      : group,
  );
}
