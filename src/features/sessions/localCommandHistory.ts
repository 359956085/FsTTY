import { hasControlCharacter } from "../../shared/validation/text";

export type LocalHistoryInsertion = "clear" | "copy";

export function parseLocalHistoryNotification(data: string, token: string | null) {
  if (!token) return null;
  const prefix = `fstty-global:${token}:`;
  if (!data.startsWith(prefix)) return null;
  const value = data.slice(prefix.length);
  if (value === "unavailable" || value === "write-failed") return { kind: "warning" as const, value: value as "unavailable" | "write-failed" };
  if (value === "execute") return { kind: "execute" as const };
  if (value.startsWith("input:")) {
    const binding = value.slice(6);
    return { kind: "input" as const, binding: (binding === "clear" ? binding : "copy") as LocalHistoryInsertion };
  }
  // Commands are recorded by the backend, including while the webview is gone.
  return null;
}

export function createLocalHistoryInsertion(command: string, binding: LocalHistoryInsertion) {
  if (binding === "copy" || !command.trim() || hasControlCharacter(command) || new TextEncoder().encode(command).byteLength > 64 * 1024) return null;
  return `\x1b[24;7~${command}`;
}

