export const WORKSPACE_STORAGE_KEY = "fstty.workspace.v1";
const WORKSPACE_LAYOUT_MIGRATION = "fstty.workspace.layout.v2";

export const WORKSPACE_LAYOUT_LIMITS = {
  leftWidth: { defaultValue: 260, min: 220, max: 420 },
  rightWidth: { defaultValue: 460, min: 360, max: 800 },
    fileRatio: { defaultValue: 75, min: 45, max: 75 },
  terminalMinWidth: 440,
} as const;

export const FILE_COLUMN_LIMITS = {
  name: { defaultValue: 140, min: 120, max: 480 },
  size: { defaultValue: 72, min: 64, max: 160 },
  modified: { defaultValue: 132, min: 112, max: 240 },
  permissions: { defaultValue: 96, min: 80, max: 180 },
} as const;

export interface WorkspaceLayoutPreferences {
  leftWidth: number;
  rightWidth: number;
  fileRatio: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface WorkspaceTabsPreferences {
  openTabs: Array<{ id: string; sessionId: string }>;
  activeTabId: string | null;
}

export interface FileColumnPreferences {
  name: number;
  size: number;
  modified: number;
  permissions: number;
}

export interface WorkspacePreferences {
  layout: WorkspaceLayoutPreferences;
  tabs: WorkspaceTabsPreferences;
  favoriteSessionIds: string[];
  fileColumns: FileColumnPreferences;
}

export interface WorkspacePreferencesPatch {
  layout?: Partial<WorkspaceLayoutPreferences>;
  tabs?: Partial<WorkspaceTabsPreferences>;
  favoriteSessionIds?: string[];
  fileColumns?: Partial<FileColumnPreferences>;
}

const MAX_STORED_SESSION_IDS = 100;
const MAX_SESSION_ID_LENGTH = 128;

function createDefaultPreferences(): WorkspacePreferences {
  return {
    layout: {
      leftWidth: WORKSPACE_LAYOUT_LIMITS.leftWidth.defaultValue,
      rightWidth: WORKSPACE_LAYOUT_LIMITS.rightWidth.defaultValue,
      fileRatio: WORKSPACE_LAYOUT_LIMITS.fileRatio.defaultValue,
      leftCollapsed: false,
      rightCollapsed: false,
    },
    tabs: {
      openTabs: [],
      activeTabId: null,
    },
    favoriteSessionIds: [],
    fileColumns: {
      name: FILE_COLUMN_LIMITS.name.defaultValue,
      size: FILE_COLUMN_LIMITS.size.defaultValue,
      modified: FILE_COLUMN_LIMITS.modified.defaultValue,
      permissions: FILE_COLUMN_LIMITS.permissions.defaultValue,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function readBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback;
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readSessionIds(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const ids = value.filter(
    (id): id is string =>
      isSessionId(id),
  );

  return [...new Set(ids)].slice(0, MAX_STORED_SESSION_IDS);
}

function readTabs(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value
    .flatMap((tab) => {
      if (
        !isRecord(tab) ||
        !isSessionId(tab.id) ||
        !isSessionId(tab.sessionId) ||
        seen.has(tab.id)
      ) {
        return [];
      }
      seen.add(tab.id);
      return [{ id: tab.id, sessionId: tab.sessionId }];
    })
    .slice(0, MAX_STORED_SESSION_IDS);
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function normalizePreferences(value: unknown): WorkspacePreferences {
  const defaults = createDefaultPreferences();
  const root = isRecord(value) ? value : {};
  const layout = isRecord(root.layout) ? root.layout : {};
  const tabs = isRecord(root.tabs) ? root.tabs : {};
  const fileColumns = isRecord(root.fileColumns) ? root.fileColumns : {};

  const storedTabs = readTabs(tabs.openTabs);
  // 兼容旧版以会话 ID 作为标签 ID 的存储，首次保存后自动转成新结构。
  const legacySessionIds = readSessionIds(tabs.openSessionIds, []);
  const openTabs = storedTabs.length > 0
    ? storedTabs
    : legacySessionIds.map((sessionId) => ({ id: sessionId, sessionId }));
  const requestedActiveId = isSessionId(tabs.activeTabId)
    ? tabs.activeTabId
    : isSessionId(tabs.activeSessionId)
      ? tabs.activeSessionId
      : null;

  return {
    layout: {
      leftWidth: readBoundedNumber(
        layout.leftWidth,
        defaults.layout.leftWidth,
        WORKSPACE_LAYOUT_LIMITS.leftWidth.min,
        WORKSPACE_LAYOUT_LIMITS.leftWidth.max,
      ),
      rightWidth: readBoundedNumber(
        layout.rightWidth,
        defaults.layout.rightWidth,
        WORKSPACE_LAYOUT_LIMITS.rightWidth.min,
        WORKSPACE_LAYOUT_LIMITS.rightWidth.max,
      ),
      fileRatio: readBoundedNumber(
        layout.fileRatio,
        defaults.layout.fileRatio,
        WORKSPACE_LAYOUT_LIMITS.fileRatio.min,
        WORKSPACE_LAYOUT_LIMITS.fileRatio.max,
      ),
      leftCollapsed: readBoolean(
        layout.leftCollapsed,
        defaults.layout.leftCollapsed,
      ),
      rightCollapsed: readBoolean(
        layout.rightCollapsed,
        defaults.layout.rightCollapsed,
      ),
    },
    tabs: {
      openTabs,
      // 活动标签必须属于已打开标签，避免删除会话后恢复出悬空状态。
      activeTabId:
        requestedActiveId && openTabs.some((tab) => tab.id === requestedActiveId)
          ? requestedActiveId
          : openTabs[0]?.id ?? null,
    },
    favoriteSessionIds: readSessionIds(
      root.favoriteSessionIds,
      defaults.favoriteSessionIds,
    ),
    fileColumns: {
      name: readBoundedNumber(
        fileColumns.name,
        defaults.fileColumns.name,
        FILE_COLUMN_LIMITS.name.min,
        FILE_COLUMN_LIMITS.name.max,
      ),
      size: readBoundedNumber(
        fileColumns.size,
        defaults.fileColumns.size,
        FILE_COLUMN_LIMITS.size.min,
        FILE_COLUMN_LIMITS.size.max,
      ),
      modified: readBoundedNumber(
        fileColumns.modified,
        defaults.fileColumns.modified,
        FILE_COLUMN_LIMITS.modified.min,
        FILE_COLUMN_LIMITS.modified.max,
      ),
      permissions: readBoundedNumber(
        fileColumns.permissions,
        defaults.fileColumns.permissions,
        FILE_COLUMN_LIMITS.permissions.min,
        FILE_COLUMN_LIMITS.permissions.max,
      ),
    },
  };
}

export function readWorkspacePreferences(): WorkspacePreferences {
  if (typeof window === "undefined") {
    return createDefaultPreferences();
  }

  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    const preferences = stored
      ? normalizePreferences(JSON.parse(stored) as unknown)
      : createDefaultPreferences();
    if (
      stored &&
      !window.localStorage.getItem(WORKSPACE_LAYOUT_MIGRATION)
    ) {
      preferences.layout.fileRatio = WORKSPACE_LAYOUT_LIMITS.fileRatio.defaultValue;
      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify(preferences),
      );
      window.localStorage.setItem(WORKSPACE_LAYOUT_MIGRATION, "1");
    }
    return preferences;
  } catch {
    return createDefaultPreferences();
  }
}

export function updateWorkspacePreferences(
  patch: WorkspacePreferencesPatch,
): WorkspacePreferences {
  const current = readWorkspacePreferences();
  // 深层合并四个独立区域，防止单项调整覆盖其他工作区偏好。
  const next = normalizePreferences({
    layout: { ...current.layout, ...patch.layout },
    tabs: { ...current.tabs, ...patch.tabs },
    favoriteSessionIds: patch.favoriteSessionIds ?? current.favoriteSessionIds,
    fileColumns: { ...current.fileColumns, ...patch.fileColumns },
  });

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 存储不可用时仍返回内存状态，界面功能不应中断。
    }
  }

  return next;
}
