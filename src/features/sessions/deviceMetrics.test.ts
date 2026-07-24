import { describe, expect, it } from "vitest";
import type { DeviceStatus } from "../../shared/api/types";
import {
  appendDeviceMetricSample,
  buildSparklineSegments,
  DEVICE_HISTORY_WINDOW_MS,
  formatNetworkRate,
  type DeviceMetricSample,
} from "./deviceMetrics";

const status: DeviceStatus = {
  sessionId: "session",
  available: true,
  cpuPercent: 25,
  memoryPercent: 50,
  networkReceivedBytes: 1_000,
  networkTransmittedBytes: 2_000,
};

describe("设备指标历史", () => {
  it("计算网络速度并裁剪10分钟前的数据", () => {
    const oldSample: DeviceMetricSample = {
      sampledAtMs: 0,
      cpuPercent: 10,
      memoryPercent: 20,
      networkDownloadBytesPerSecond: null,
      networkUploadBytesPerSecond: null,
    };
    const first = appendDeviceMetricSample([], status, 10_000, null);
    const second = appendDeviceMetricSample(
      [oldSample, ...first.history],
      {
        ...status,
        networkReceivedBytes: 6_000,
        networkTransmittedBytes: 12_000,
      },
      DEVICE_HISTORY_WINDOW_MS + 20_000,
      first.networkCounter,
    );

    expect(second.history).toHaveLength(1);
    expect(second.history[0].networkDownloadBytesPerSecond).toBeCloseTo(
      5_000 / (DEVICE_HISTORY_WINDOW_MS + 10_000) * 1_000,
    );
    expect(second.history[0].networkUploadBytesPerSecond).toBeCloseTo(
      10_000 / (DEVICE_HISTORY_WINDOW_MS + 10_000) * 1_000,
    );
  });

  it("计数倒退或异常时间时不产生负速度", () => {
    const first = appendDeviceMetricSample([], status, 1_000, null);
    const reset = appendDeviceMetricSample(
      first.history,
      { ...status, networkReceivedBytes: 10, networkTransmittedBytes: 20 },
      2_000,
      first.networkCounter,
    );
    expect(
      reset.history[reset.history.length - 1]?.networkDownloadBytesPerSecond,
    ).toBeNull();
    expect(
      appendDeviceMetricSample(reset.history, status, Number.NaN, reset.networkCounter).history,
    ).toEqual(reset.history);
  });

  it("按缺失值拆分折线并限制百分比", () => {
    const history: DeviceMetricSample[] = [
      {
        sampledAtMs: 0,
        cpuPercent: 0,
        memoryPercent: 20,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      },
      {
        sampledAtMs: DEVICE_HISTORY_WINDOW_MS / 2,
        cpuPercent: null,
        memoryPercent: 50,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      },
      {
        sampledAtMs: DEVICE_HISTORY_WINDOW_MS,
        cpuPercent: 120,
        memoryPercent: 80,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      },
    ];
    const segments = buildSparklineSegments(
      history,
      "cpuPercent",
      100,
      20,
      DEVICE_HISTORY_WINDOW_MS,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0][0]).toEqual({ x: 0, y: 20 });
    expect(segments[1][0]).toEqual({ x: 100, y: 0 });
  });

  it("固定近10分钟横轴并保留无数据区域", () => {
    const windowEndMs = DEVICE_HISTORY_WINDOW_MS;
    const history: DeviceMetricSample[] = [
      {
        sampledAtMs: windowEndMs - 60_000,
        cpuPercent: 25,
        memoryPercent: 50,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      },
      {
        sampledAtMs: windowEndMs,
        cpuPercent: 30,
        memoryPercent: 55,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      },
    ];

    const segments = buildSparklineSegments(history, "cpuPercent", 100, 20, windowEndMs);
    expect(segments[0][0].x).toBe(90);
    expect(segments[0][1].x).toBe(100);
  });
});

describe("网络速度格式", () => {
  it("覆盖单位边界和无效值", () => {
    expect(formatNetworkRate(null)).toBe("--");
    expect(formatNetworkRate(-1)).toBe("--");
    expect(formatNetworkRate(0)).toBe("0 B/s");
    expect(formatNetworkRate(1024)).toBe("1.0 KB/s");
    expect(formatNetworkRate(1024 * 1024)).toBe("1.0 MB/s");
    expect(formatNetworkRate(1024 * 1024 * 1024)).toBe("1.0 GB/s");
  });
});
