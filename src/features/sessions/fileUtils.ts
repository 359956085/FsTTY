import type { FileEntry } from "../../shared/api/types";

export function isRemoteMoveCandidate(file: FileEntry) {
  return file.kind === "file" || file.kind === "folder";
}

export function canMoveRemoteEntry(source: FileEntry, targetDirectory: string) {
  if (remoteParentPath(source.path) === targetDirectory) {
    return false;
  }
  return !(
    source.kind === "folder" &&
    (targetDirectory === source.path || targetDirectory.startsWith(`${source.path}/`))
  );
}

export function remoteParentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

export function buildBreadcrumbs(path: string) {
  const segments = path.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...segments.map((segment, index) => ({
      label: segment,
      path: `/${segments.slice(0, index + 1).join("/")}`,
    })),
  ];
}

export function formatSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function createModifiedTimeFormatter(language: string) {
  return new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function formatModifiedTime(
  value: number | null | undefined,
  formatter: Intl.DateTimeFormat,
) {
  return value ? formatter.format(new Date(value)) : "--";
}
