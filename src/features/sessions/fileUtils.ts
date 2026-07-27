import type { FileEntry } from "../../shared/api/types";

export interface FileNameClick {
  path: string;
  timeMs: number;
}

export function isSlowRenameClick(
  previous: FileNameClick | null,
  current: FileNameClick,
  clickDetail: number,
  windowMs = 1500,
) {
  return (
    clickDetail === 1 &&
    previous?.path === current.path &&
    current.timeMs > previous.timeMs &&
    current.timeMs - previous.timeMs <= windowMs
  );
}

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

interface TransferSpeedSample {
  transferredBytes: number;
  timeMs: number;
}

export interface TransferSpeedMeasurement {
  speedBytesPerSecond: number;
  speedUpdatedAtMs: number;
}

export function createTransferSpeedTracker(windowMs = 1000) {
  let samples: TransferSpeedSample[] = [];
  let measurement: TransferSpeedMeasurement = {
    speedBytesPerSecond: 0,
    speedUpdatedAtMs: 0,
  };

  const reset = (transferredBytes: number, timeMs: number) => {
    samples =
      Number.isFinite(transferredBytes) &&
      transferredBytes >= 0 &&
      Number.isFinite(timeMs)
        ? [{ transferredBytes, timeMs }]
        : [];
    measurement = {
      speedBytesPerSecond: 0,
      speedUpdatedAtMs: Number.isFinite(timeMs) ? timeMs : 0,
    };
    return measurement;
  };

  return {
    update(transferredBytes: number, timeMs: number): TransferSpeedMeasurement {
      const latest = samples[samples.length - 1];
      if (
        !Number.isFinite(transferredBytes) ||
        transferredBytes < 0 ||
        !Number.isFinite(timeMs) ||
        !latest ||
        transferredBytes < latest.transferredBytes ||
        timeMs <= latest.timeMs
      ) {
        return reset(transferredBytes, timeMs);
      }

      if (transferredBytes === latest.transferredBytes) {
        return measurement;
      }

      samples.push({ transferredBytes, timeMs });
      const cutoff = timeMs - windowMs;
      // 保留窗口边界前一个样本，避免低频事件下速度突然归零。
      while (samples.length > 2 && samples[1].timeMs <= cutoff) {
        samples.shift();
      }

      const first = samples[0];
      const elapsedMs = timeMs - first.timeMs;
      const speedBytesPerSecond =
        elapsedMs > 0
          ? ((transferredBytes - first.transferredBytes) * 1000) / elapsedMs
          : 0;
      measurement = {
        speedBytesPerSecond:
          Number.isFinite(speedBytesPerSecond) && speedBytesPerSecond > 0
            ? speedBytesPerSecond
            : 0,
        speedUpdatedAtMs: timeMs,
      };
      return measurement;
    },
  };
}

export function formatTransferSpeed(speedBytesPerSecond: number) {
  const speed =
    Number.isFinite(speedBytesPerSecond) && speedBytesPerSecond > 0
      ? speedBytesPerSecond
      : 0;
  return `${formatSize(speed)}/s`;
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
