import type {
  McpGroupPermission,
  McpPermissionKey,
  SessionGroup,
} from "../../shared/api/types";

export const MCP_PERMISSION_FIELDS = [
  "enabled",
  "sessionRead",
  "fileRead",
  "commandExecute",
  "fileWrite",
  "fileDelete",
] as const satisfies readonly McpPermissionKey[];

export const MCP_PERMISSION_LABEL_KEYS: Record<McpPermissionKey, string> = {
  enabled: "settings.mcpAccess",
  sessionRead: "settings.mcpSessionRead",
  fileRead: "settings.mcpFileRead",
  commandExecute: "settings.mcpCommand",
  fileWrite: "settings.mcpFileWrite",
  fileDelete: "settings.mcpDelete",
};

export function defaultMcpPermission(groupName: string): McpGroupPermission {
  return {
    groupName,
    enabled: false,
    sessionRead: true,
    fileRead: true,
    commandExecute: false,
    fileWrite: false,
    fileDelete: false,
  };
}

export function permissionFrom(
  permissions: readonly McpGroupPermission[],
  groupName: string,
): McpGroupPermission {
  return (
    permissions.find((permission) => permission.groupName === groupName) ??
    defaultMcpPermission(groupName)
  );
}

export function permissionsChanged(
  groups: readonly SessionGroup[],
  draft: readonly McpGroupPermission[],
  saved: readonly McpGroupPermission[],
): boolean {
  return groups.some((group) => {
    const draftPermission = permissionFrom(draft, group.name);
    const savedPermission = permissionFrom(saved, group.name);
    return MCP_PERMISSION_FIELDS.some(
      (field) => draftPermission[field] !== savedPermission[field],
    );
  });
}

export function validateMcpPort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}
