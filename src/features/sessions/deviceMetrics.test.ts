import { describe, expect, it } from "vitest";
import {
  buildSparklineSegments,
  DEVICE_HISTORY_WINDOW_MS,
  formatNetworkRate,
  type DeviceMetricSample,
} from "./deviceMetrics";

describe("设备指标历史", () => {
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

  it("只绘制后台时间窗口内的样本，不修改缓存", () => {
    const windowEndMs = 2 * DEVICE_HISTORY_WINDOW_MS;
    const history = [0, DEVICE_HISTORY_WINDOW_MS, windowEndMs, windowEndMs + 1].map(
      (sampledAtMs): DeviceMetricSample => ({
        sampledAtMs,
        cpuPercent: 25,
        memoryPercent: 50,
        networkDownloadBytesPerSecond: null,
        networkUploadBytesPerSecond: null,
      }),
    );
    expect(buildSparklineSegments(history, "cpuPercent", 100, 20, windowEndMs))
      .toEqual([[{ x: 0, y: 15 }, { x: 100, y: 15 }]]);
    expect(history).toHaveLength(4);
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
