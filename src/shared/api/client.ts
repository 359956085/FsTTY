import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  CreateSessionPayload,
  DeviceStatus,
  FileEntry,
  Language,
  Session,
  SessionConnection,
  SessionGroup,
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
  openSession(sessionId: string) {
    return invoke<SessionConnection>("open_session", { sessionId });
  },
  listRemoteFiles(sessionId: string, path?: string) {
    return invoke<FileEntry[]>("list_remote_files", { sessionId, path });
  },
  getDeviceStatus(sessionId: string) {
    return invoke<DeviceStatus>("get_device_status", { sessionId });
  },
  getAppSettings() {
    return invoke<AppSettings>("get_app_settings");
  },
  setLanguage(language: Language) {
    return invoke<AppSettings>("set_language", { language });
  },
};

