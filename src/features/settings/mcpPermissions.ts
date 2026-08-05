import type {
  McpCommandPolicy,
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
    commandPolicy: defaultMcpCommandPolicy(),
  };
}

export function defaultMcpCommandPolicy(): McpCommandPolicy {
  return { enabled: false, mode: "allow", rules: [] };
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
    return (
      MCP_PERMISSION_FIELDS.some(
        (field) => draftPermission[field] !== savedPermission[field],
      ) || !commandPoliciesEqual(draftPermission.commandPolicy, savedPermission.commandPolicy)
    );
  });
}

function commandPoliciesEqual(left: McpCommandPolicy, right: McpCommandPolicy): boolean {
  return (
    left.enabled === right.enabled &&
    left.mode === right.mode &&
    left.rules.length === right.rules.length &&
    left.rules.every(
      (rule, index) =>
        rule.matchType === right.rules[index]?.matchType &&
        rule.pattern === right.rules[index]?.pattern,
    )
  );
}

export type McpCommandPolicyValidationError =
  | "empty"
  | "invalid"
  | "duplicate"
  | "tooMany";

export function validateMcpCommandPolicy(
  policy: McpCommandPolicy,
): McpCommandPolicyValidationError | null {
  if (policy.rules.length > 100) return "tooMany";
  const seen = new Set<string>();
  for (const rule of policy.rules) {
    const pattern = rule.pattern.trim();
    if (!pattern) return "empty";
    if (
      new TextEncoder().encode(pattern).length > 4096 ||
      Array.from(pattern).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      })
    ) {
      return "invalid";
    }
    const key = `${rule.matchType}\u0000${pattern}`;
    if (seen.has(key)) return "duplicate";
    seen.add(key);
  }
  return null;
}

export function normalizeMcpCommandPolicy(policy: McpCommandPolicy): McpCommandPolicy {
  return {
    ...policy,
    rules: policy.rules.map((rule) => ({ ...rule, pattern: rule.pattern.trim() })),
  };
}

export function validateMcpPort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}
