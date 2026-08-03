export type Language = "zh-CN" | "en-US";
export type ClipboardContentKind = "empty" | "text" | "nonText";

export interface AppSettings {
  language: Language;
  autoUpdate: boolean;
  updateProxy: string;
  allowRemoteClipboardWrite: boolean;
  recordMcpToolInputs: boolean;
  ignoredUpdateVersion: string | null;
  mcpEnabled: boolean;
  mcpHttpEnabled: boolean;
  mcpHttpPort: number;
  mcpGroupPermissions: McpGroupPermission[];
}

export interface McpGroupPermission {
  groupName: string;
  enabled: boolean;
  sessionRead: boolean;
  fileRead: boolean;
  commandExecute: boolean;
  fileWrite: boolean;
  fileDelete: boolean;
}

export interface CommandHistoryEntry {
  id: string;
  command: string;
  executedAt: string;
}

export interface CommandHistoryPage {
  entries: CommandHistoryEntry[];
  olderCursor: string | null;
  hasMore: boolean;
}

export interface CommandHistorySettings {
  deduplicate: boolean;
  entryCount: number;
  duplicateCount: number;
}

export interface CommandHistoryImportResult {
  importedCount: number;
  mergedCount: number;
  totalCount: number;
}

export type McpPermissionKey =
  | "enabled"
  | "sessionRead"
  | "fileRead"
  | "commandExecute"
  | "fileWrite"
  | "fileDelete";

export interface McpPermissionCatalogEntry {
  permissionKey: McpPermissionKey;
  tools: string[];
}

export interface McpHttpStatus {
  running: boolean;
  address: string;
}

export type McpClientTarget =
  | "genericJson"
  | "codex"
  | "claude"
  | "cursor"
  | "vsCode"
  | "geminiCli";

export type LocalAgentTarget =
  | Exclude<McpClientTarget, "genericJson">
  | "openCode"
  | "trae"
  | "traeCn";

export type LocalAgentSetupState =
  | "notDetected"
  | "missing"
  | "current"
  | "outdated"
  | "invalid";

export interface LocalAgentCapability {
  target: LocalAgentTarget;
  installed: boolean;
  state: LocalAgentSetupState;
  detail: string | null;
}

export type LocalAgentStepStatus =
  | "configured"
  | "current"
  | "manualRequired"
  | "failed";

export interface LocalAgentConfigureResult {
  target: LocalAgentTarget;
  mcpStatus: LocalAgentStepStatus;
  promptStatus: LocalAgentStepStatus;
  message: string | null;
}

export interface SessionGroup {
  name: string;
  sessions: Session[];
}

export type SessionAuth =
  | { kind: "password" }
  | {
      kind: "privateKey";
      source: "file";
      path: string;
      passphraseRequired: boolean;
    }
  | {
      kind: "privateKey";
      source: "inline";
      passphraseRequired: boolean;
    };

export type PrivateKeyMaterialAction =
  | { mode: "preserve" }
  | { mode: "replace"; value: string };

export type SessionAuthInput =
  | { kind: "password" }
  | { kind: "privateKey"; source: "file"; path: string }
  | {
      kind: "privateKey";
      source: "inline";
      material: PrivateKeyMaterialAction;
    };

export type CredentialAction =
  | { mode: "preserve" }
  | { mode: "replace"; value: string }
  | { mode: "useOnce"; value: string }
  | { mode: "clear" };

export interface Session {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  auth: SessionAuth;
  credentialState: "stored" | "missing" | "notRequired";
  loginSavePrompted: boolean;
}

export type LoginSaveDecision =
  | {
      mode: "save";
      username?: string;
      password?: string;
    }
  | { mode: "decline" };

export interface CreateSessionPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  auth: SessionAuthInput;
  credential: CredentialAction;
}

export interface UpdateSessionPayload extends CreateSessionPayload {
  id: string;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export interface SshConnection {
  connectionId: string;
  sessionId: string;
  homePath: string;
  sftpAvailable: boolean;
}

export interface HostKeyChallenge {
  challengeId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  expiresInSeconds: number;
}

export interface HostKeyChange {
  host: string;
  port: number;
  algorithm: string;
  oldFingerprint: string;
  newFingerprint: string;
}

export type ConnectResult =
  | { kind: "connected"; connection: SshConnection }
  | { kind: "hostKeyRequired"; challenge: HostKeyChallenge }
  | { kind: "hostKeyChanged"; change: HostKeyChange }
  | {
      kind: "credentialRequired";
      credentialKind: "password" | "privateKeyPassphrase";
    };

export type TerminalEvent =
  | { kind: "data"; connectionId: string; data: string }
  | {
      kind: "disconnected";
      connectionId: string;
      exitCode?: number | null;
      message: string;
    }
  | { kind: "error"; connectionId: string; message: string };

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "folder" | "symlink" | "other";
  size?: number | null;
  modifiedAt?: number | null;
  owner: string;
  group: string;
  permissions: string;
}

export interface DeviceStatus {
  sessionId: string;
  available: boolean;
  os?: string | null;
  architecture?: string | null;
  uptimeSeconds?: number | null;
  cpuPercent?: number | null;
  cpuCores?: number | null;
  memoryPercent?: number | null;
  memoryUsedGb?: number | null;
  memoryTotalGb?: number | null;
  diskPercent?: number | null;
  diskUsedGb?: number | null;
  diskTotalGb?: number | null;
  networkReceivedBytes?: number | null;
  networkTransmittedBytes?: number | null;
}

export type TransferEvent =
  | {
      kind: "progress";
      transferId: string;
      transferredBytes: number;
      totalBytes: number;
    }
  | {
      kind: "completed";
      transferId: string;
      transferredBytes: number;
      totalBytes: number;
    }
  | {
      kind: "cancelled";
      transferId: string;
      transferredBytes: number;
      totalBytes: number;
    };
