export type Language = "zh-CN" | "en-US";
export type ThemePreference = "system" | "light" | "dark";
export type UpdateSourcePreference = "auto" | "github" | "cnb";
export type ClipboardContentKind = "empty" | "text" | "nonText";

export interface AppSettings {
  language: Language;
  theme: ThemePreference;
  autoUpdate: boolean;
  updateSource: UpdateSourcePreference;
  updateProxy: string;
  allowRemoteClipboardWrite: boolean;
  recordMcpToolInputs: boolean;
  ignoredUpdateVersion: string | null;
  mcpEnabled: boolean;
  mcpHttpEnabled: boolean;
  mcpHttpPort: number;
  mcpGroupPermissions: McpGroupPermission[];
  shortcuts: ShortcutSettings;
}

export type AppUpdateSource = "cnb" | "gitHub";

export interface AppUpdateInfo {
  body?: string;
  date?: string;
  source: AppUpdateSource;
  version: string;
}

export type AppUpdateProgress =
  | { kind: "started"; totalBytes?: number | null }
  | { kind: "progress"; chunkBytes: number }
  | { kind: "finished" };

export interface ShortcutBinding {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ShortcutSettings {
  terminalCopy: ShortcutBinding;
  terminalPaste: ShortcutBinding;
  commandHistory: ShortcutBinding;
  commandHistorySearch: ShortcutBinding;
}

export interface McpGroupPermission {
  groupName: string;
  enabled: boolean;
  sessionRead: boolean;
  fileRead: boolean;
  fileTransfer: boolean;
  commandExecute: boolean;
  fileWrite: boolean;
  fileDelete: boolean;
  commandPolicy: McpCommandPolicy;
}

export type McpCommandPolicyMode = "allow" | "exclude";
export type McpCommandMatchType = "exact" | "glob";

export interface McpCommandRule {
  matchType: McpCommandMatchType;
  pattern: string;
}

export interface McpCommandPolicy {
  enabled: boolean;
  mode: McpCommandPolicyMode;
  allowRules: McpCommandRule[];
  excludeRules: McpCommandRule[];
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
  | "fileRead"
  | "fileTransfer"
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

export type McpTransport = "stdio" | "http";

export type McpClientTarget =
  | "genericJson"
  | "codex"
  | "claude"
  | "cursor"
  | "vsCode"
  | "geminiCli"
  | "dsh";

export type LocalAgentTarget =
  | Exclude<McpClientTarget, "genericJson" | "dsh">
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
  shellName?: "bash" | "zsh" | null;
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

export type LightweightModePhase = "normal" | "preparing" | "detached";
export type LightweightSnapshotKind = "full" | "viewport";

export interface LightweightTerminalRequest {
  runtimeId: string;
  connection: SshConnection;
  currentPath: string;
  columns: number;
  rows: number;
  shellIntegrationToken?: string | null;
}

export interface PreservedTerminalSummary {
  runtimeId: string;
  connectionId: string;
  sessionId: string;
  currentPath: string;
}

export interface LightweightModeState {
  active: boolean;
  suppressConfirmation: boolean;
  phase: LightweightModePhase;
  terminals: PreservedTerminalSummary[];
  transferJobs: TransferJobSummary[];
}

export interface PreservedTerminalAttachment {
  runtimeId: string;
  connection: SshConnection;
  currentPath: string;
  columns: number;
  rows: number;
  truncated: boolean;
  shellIntegrationToken?: string | null;
}

export type TerminalResumeEvent =
  | {
      kind: "snapshot";
      connectionId: string;
      data: string;
      chunkIndex: number;
      totalChunks: number;
      truncated: boolean;
    }
  | { kind: "data"; connectionId: string; data: string }
  | {
      kind: "disconnected";
      connectionId: string;
      exitCode?: number | null;
      message: string;
    }
  | { kind: "error"; connectionId: string; message: string }
  | { kind: "ready"; connectionId: string; truncated: boolean };

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

export interface DeviceMetricSample {
  sampledAtMs: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  networkDownloadBytesPerSecond: number | null;
  networkUploadBytesPerSecond: number | null;
}

export interface DeviceMetricsSnapshot {
  connectionId: string;
  status: DeviceStatus | null;
  history: DeviceMetricSample[];
  windowEndMs: number;
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

export type TransferJobDirection = "upload" | "download";
export type TransferJobState =
  | "running"
  | "waitingForConflict"
  | "completed"
  | "cancelled"
  | "failed";

export type StartTransferJobRequest =
  | {
      kind: "uploadBatch";
      runtimeId: string;
      connectionId: string;
      localPaths: string[];
      remoteDirectory: string;
    }
  | {
      kind: "download";
      runtimeId: string;
      connectionId: string;
      remotePath: string;
      localPath: string;
    };

export interface TransferJobSummary {
  jobId: string;
  runtimeId: string;
  connectionId: string;
  direction: TransferJobDirection;
  fileName: string;
  batchIndex: number;
  batchTotal: number;
  transferredBytes: number;
  totalBytes: number;
  state: TransferJobState;
  message?: string | null;
  uploaded: number;
  skipped: number;
  failed: number;
}

export type TransferConflictDecision = "overwrite" | "skip" | "cancel";

export type TransferJobEvent = { kind: "updated"; job: TransferJobSummary };
