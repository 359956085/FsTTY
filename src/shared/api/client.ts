import { invoke, type Channel } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ClipboardContentKind,
  ConnectResult,
  CreateSessionPayload,
  DeviceStatus,
  FileEntry,
  Language,
  LoginSaveDecision,
  Session,
  SessionGroup,
  TerminalEvent,
  TransferEvent,
  UpdateSessionPayload,
} from "./types";

export const api = {
  listSessions() {
    return invoke<SessionGroup[]>("list_sessions");
  },
  createSession(payload: CreateSessionPayload) {
    return invoke<Session>("create_session", { payload });
  },
  updateSession(payload: UpdateSessionPayload) {
    return invoke<Session>("update_session", { payload });
  },
  deleteSession(sessionId: string) {
    return invoke<void>("delete_session", { sessionId });
  },
  reorderSessionGroup(groupName: string, targetIndex: number) {
    return invoke<void>("reorder_session_group", { groupName, targetIndex });
  },
  reorderSession(sessionId: string, targetGroup: string, targetIndex: number) {
    return invoke<void>("reorder_session", { sessionId, targetGroup, targetIndex });
  },
  renameSessionGroup(groupName: string, newName: string) {
    return invoke<void>("rename_session_group", { groupName, newName });
  },
  deleteSessionGroup(groupName: string) {
    return invoke<string[]>("delete_session_group", { groupName });
  },
  setSessionCredential(sessionId: string, credential: string) {
    return invoke<Session>("set_session_credential", { sessionId, credential });
  },
  resolveSessionLoginSavePrompt(sessionId: string, decision: LoginSaveDecision) {
    return invoke<Session>("resolve_session_login_save_prompt", { sessionId, decision });
  },
  connectSession(
    sessionId: string,
    columns: number,
    rows: number,
    onEvent: Channel<TerminalEvent>,
    oneTimeCredential?: string,
    oneTimeUsername?: string,
  ) {
    return invoke<ConnectResult>("connect_session", {
      sessionId,
      columns,
      rows,
      onEvent,
      oneTimeCredential: oneTimeCredential ?? null,
      oneTimeUsername: oneTimeUsername ?? null,
    });
  },
  trustHostKey(sessionId: string, challengeId: string) {
    return invoke<void>("trust_host_key", { sessionId, challengeId });
  },
  forgetHostKey(sessionId: string) {
    return invoke<boolean>("forget_host_key", { sessionId });
  },
  writeTerminal(connectionId: string, data: string) {
    return invoke<void>("write_terminal", { connectionId, data });
  },
  resizeTerminal(connectionId: string, columns: number, rows: number) {
    return invoke<void>("resize_terminal", { connectionId, columns, rows });
  },
  disconnectSession(connectionId: string) {
    return invoke<void>("disconnect_session", { connectionId });
  },
  listRemoteFiles(connectionId: string, path: string) {
    return invoke<FileEntry[]>("list_remote_files", { connectionId, path });
  },
  createRemoteDirectory(connectionId: string, parentPath: string, name: string) {
    return invoke<void>("create_remote_directory", { connectionId, parentPath, name });
  },
  renameRemoteEntry(connectionId: string, path: string, newName: string) {
    return invoke<void>("rename_remote_entry", { connectionId, path, newName });
  },
  moveRemoteEntry(connectionId: string, sourcePath: string, targetDirectory: string) {
    return invoke<void>("move_remote_entry", { connectionId, sourcePath, targetDirectory });
  },
  deleteRemoteEntry(connectionId: string, path: string) {
    return invoke<void>("delete_remote_entry", { connectionId, path });
  },
  uploadFile(
    connectionId: string,
    transferId: string,
    localPath: string,
    remoteDirectory: string,
    overwrite: boolean,
    onProgress: Channel<TransferEvent>,
  ) {
    return invoke<void>("upload_file", {
      connectionId,
      transferId,
      localPath,
      remoteDirectory,
      overwrite,
      onProgress,
    });
  },
  downloadFile(
    connectionId: string,
    transferId: string,
    remotePath: string,
    localPath: string,
    overwrite: boolean,
    onProgress: Channel<TransferEvent>,
  ) {
    return invoke<void>("download_file", {
      connectionId,
      transferId,
      remotePath,
      localPath,
      overwrite,
      onProgress,
    });
  },
  cancelTransfer(transferId: string) {
    return invoke<boolean>("cancel_transfer", { transferId });
  },
  getDeviceStatus(connectionId: string) {
    return invoke<DeviceStatus>("get_device_status", { connectionId });
  },
  getSystemClipboardContentKind() {
    return invoke<ClipboardContentKind>("get_system_clipboard_content_kind");
  },
  getAppSettings() {
    return invoke<AppSettings>("get_app_settings");
  },
  setLanguage(language: Language) {
    return invoke<AppSettings>("set_language", { language });
  },
  setIgnoredUpdateVersion(version: string) {
    return invoke<AppSettings>("set_ignored_update_version", { version });
  },
  updateAppSettings(
    autoUpdate: boolean,
    updateProxy: string,
    allowRemoteClipboardWrite: boolean,
  ) {
    return invoke<AppSettings>("update_app_settings", {
      autoUpdate,
      updateProxy,
      allowRemoteClipboardWrite,
    });
  },
};
