import type { DeviceStatus } from "../../shared/api/types";

export const DEVICE_POLL_INTERVAL_MS = 5_000;
export const DEVICE_HISTORY_WINDOW_MS = 10 * 60 * 1_000;

export interface DeviceMetricSample {
  sampledAtMs: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  networkDownloadBytesPerSecond: number | null;
  networkUploadBytesPerSecond: number | null;
}

export interface DeviceNetworkCounterSample {
  sampledAtMs: number;
  receivedBytes: number;
  transmittedBytes: number;
}

export interface SparklinePoint {
  x: number;
  y: number;
}

export interface DeviceHistoryUpdate {
  history: DeviceMetricSample[];
  networkCounter: DeviceNetworkCounterSample | null;
}

export function appendDeviceMetricSample(
  history: readonly DeviceMetricSample[],
  status: DeviceStatus,
  sampledAtMs: number,
  previousCounter: DeviceNetworkCounterSample | null,
): DeviceHistoryUpdate {
  if (
    !Number.isFinite(sampledAtMs) ||
    (history.length > 0 && sampledAtMs <= history[history.length - 1].sampledAtMs)
  ) {
    return { history: [...history], networkCounter: null };
  }

  const networkCounter = readNetworkCounter(status, sampledAtMs);
  const elapsedMs =
    networkCounter && previousCounter
      ? networkCounter.sampledAtMs - previousCounter.sampledAtMs
      : 0;
  const countersAdvanced =
    networkCounter &&
    previousCounter &&
    elapsedMs > 0 &&
    networkCounter.receivedBytes >= previousCounter.receivedBytes &&
    networkCounter.transmittedBytes >= previousCounter.transmittedBytes;
  const sample: DeviceMetricSample = {
    sampledAtMs,
    cpuPercent: normalizePercent(status.cpuPercent),
    memoryPercent: normalizePercent(status.memoryPercent),
    networkDownloadBytesPerSecond: countersAdvanced
      ? ((networkCounter.receivedBytes - previousCounter.receivedBytes) * 1_000) / elapsedMs
      : null,
    networkUploadBytesPerSecond: countersAdvanced
      ? ((networkCounter.transmittedBytes - previousCounter.transmittedBytes) * 1_000) /
        elapsedMs
      : null,
  };
  const cutoff = sampledAtMs - DEVICE_HISTORY_WINDOW_MS;
  return {
    history: [...history.filter((item) => item.sampledAtMs >= cutoff), sample],
    networkCounter,
  };
}

export function buildSparklineSegments(
  history: readonly DeviceMetricSample[],
  metric: "cpuPercent" | "memoryPercent",
  width = 120,
  height = 24,
  windowEndMs = history[history.length - 1]?.sampledAtMs ?? 0,
): SparklinePoint[][] {
  if (
    history.length === 0 ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(windowEndMs)
  ) {
    return [];
  }
  // 横轴始终代表完整时间窗口，避免少量样本被拉伸到整张图。
  const windowStartMs = windowEndMs - DEVICE_HISTORY_WINDOW_MS;
  const segments: SparklinePoint[][] = [];
  let segment: SparklinePoint[] = [];

  for (const sample of history) {
    if (sample.sampledAtMs < windowStartMs || sample.sampledAtMs > windowEndMs) {
      continue;
    }
    const value = sample[metric];
    if (value == null || !Number.isFinite(value)) {
      if (segment.length > 0) {
        segments.push(segment);
        segment = [];
      }
      continue;
    }
    segment.push({
      x: ((sample.sampledAtMs - windowStartMs) / DEVICE_HISTORY_WINDOW_MS) * width,
      y: height - (Math.min(100, Math.max(0, value)) / 100) * height,
    });
  }
  if (segment.length > 0) {
    segments.push(segment);
  }
  return segments;
}

export function formatNetworkRate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return "--";
  }
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0
    ? `${Math.round(scaled)} ${units[unitIndex]}`
    : `${scaled.toFixed(1)} ${units[unitIndex]}`;
}

function readNetworkCounter(
  status: DeviceStatus,
  sampledAtMs: number,
): DeviceNetworkCounterSample | null {
  const receivedBytes = status.networkReceivedBytes;
  const transmittedBytes = status.networkTransmittedBytes;
  if (
    receivedBytes == null ||
    transmittedBytes == null ||
    !Number.isFinite(receivedBytes) ||
    !Number.isFinite(transmittedBytes) ||
    receivedBytes < 0 ||
    transmittedBytes < 0
  ) {
    return null;
  }
  return { sampledAtMs, receivedBytes, transmittedBytes };
}

function normalizePercent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? null
    : Math.min(100, Math.max(0, value));
}
