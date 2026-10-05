import { isLocalSession, type LocalShell, type WorkspaceSession } from "../../shared/api/types";

export const LOCAL_SHELL_LABELS: Record<LocalShell, string> = {
  cmd: "CMD", powershell: "PowerShell", gitBash: "Git Bash",
};

export function sessionDescription(session: WorkspaceSession) {
  if (isLocalSession(session)) return `${LOCAL_SHELL_LABELS[session.shell]}${session.startingDirectory ? ` · ${session.startingDirectory}` : ""}`;
  return session.username ? `${session.username}@${session.host}` : session.host;
}
