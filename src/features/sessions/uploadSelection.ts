import type { LocalUploadEntry } from "../../shared/api/types";
export const uploadPathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function compactUploadSelection(entries: LocalUploadEntry[]): LocalUploadEntry[] {
  const sorted = [...entries].sort((a, b) => uploadPathKey(a.path).length - uploadPathKey(b.path).length);
  const result: LocalUploadEntry[] = [];
  for (const entry of sorted) {
    const key = uploadPathKey(entry.path);
    if (!result.some((p) => uploadPathKey(p.path) === key || (p.kind === "folder" && key.startsWith(uploadPathKey(p.path) + "/"))))
      result.push(entry);
  }
  return result;
}
