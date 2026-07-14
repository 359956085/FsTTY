export type Language = "zh-CN" | "en-US";

export interface AppSettings {
  language: Language;
}

export interface SessionGroup {
  name: string;
  sessions: Session[];
}

export interface Session {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  status: "online" | "offline";
  latencyMs?: number | null;
  os: string;
}

export interface CreateSessionPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
}

export interface UpdateSessionPayload extends Partial<CreateSessionPayload> {
  id: string;
}

export interface SessionConnection {
  session: Session;
  terminalOutput: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number | null;
  modified: string;
  owner: string;
  group: string;
  permissions: string;
}

export interface DeviceStatus {
  sessionId: string;
  ip: string;
  username: string;
  os: string;
  uptime: string;
  cpuPercent: number;
  cpuCores: number;
  memoryPercent: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  diskPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  services: ServiceStatus[];
}

export interface ServiceStatus {
  name: string;
  state: string;
  port: number;
}
