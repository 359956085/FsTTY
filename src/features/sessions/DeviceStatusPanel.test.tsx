// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceMetricSample, DeviceStatus } from "../../shared/api/types";
import i18n from "../../shared/i18n";
import { DeviceStatusPanel } from "./DeviceStatusPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const status: DeviceStatus = { sessionId: "session", available: true, cpuPercent: 25, memoryPercent: 50 };
const sample: DeviceMetricSample = {
  sampledAtMs: 900_000,
  cpuPercent: 25,
  memoryPercent: 50,
  networkDownloadBytesPerSecond: 100,
  networkUploadBytesPerSecond: 200,
};

describe("设备统计曲线", () => {
  it("首轮等待显示加载文案，失败或超时后才显示不可用", () => {
    const props = { connected: true, loading: true, status: null, history: [], windowEndMs: 0 };
    const { getByText, queryByText, rerender } = render(<DeviceStatusPanel {...props} />);
    expect(getByText(i18n.t("common.loading"))).toBeTruthy();
    expect(queryByText(i18n.t("sessions.deviceUnavailable"))).toBeNull();
    rerender(<DeviceStatusPanel {...props} loading={false} />);
    expect(getByText(i18n.t("sessions.deviceUnavailable"))).toBeTruthy();
    expect(queryByText(i18n.t("common.loading"))).toBeNull();
  });

  it("未连接时仍显示连接提示，不显示加载态", () => {
    const { getByText, queryByText } = render(
      <DeviceStatusPanel connected={false} history={[]} loading status={null} windowEndMs={0} />,
    );
    expect(getByText(i18n.t("sessions.connectForDevice"))).toBeTruthy();
    expect(queryByText(i18n.t("common.loading"))).toBeNull();
  });

  it("已有缓存优先显示曲线，刷新不被加载占位替换", () => {
    const { container, queryByText } = render(
      <DeviceStatusPanel connected history={[sample]} loading status={status} windowEndMs={900_000} />,
    );
    expect(container.querySelectorAll(".metric-sparkline")).toHaveLength(2);
    expect(queryByText(i18n.t("common.loading"))).toBeNull();
    expect(queryByText(i18n.t("sessions.deviceUnavailable"))).toBeNull();
  });

  it("横轴只使用后台时间，WebView 时钟变化不移动或丢失样本", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100_000_000);
    const props = { connected: true, loading: false, status, history: [sample], windowEndMs: 1_000_000 };
    const { container, rerender } = render(<DeviceStatusPanel {...props} />);
    const point = container.querySelector(".metric-sparkline circle");
    expect(point?.getAttribute("cx")).toBe("100");
    const before = container.querySelector(".metric-sparkline")?.innerHTML;
    clock.mockReturnValue(10);
    rerender(<DeviceStatusPanel {...props} />);
    expect(container.querySelector(".metric-sparkline")?.innerHTML).toBe(before);
  });

  it("采样失败保留断点，CPU 与内存均不画成零值", () => {
    const history = [
      sample,
      { ...sample, sampledAtMs: 905_000, cpuPercent: null, memoryPercent: null },
      { ...sample, sampledAtMs: 910_000, cpuPercent: 50, memoryPercent: 75 },
    ];
    const { container } = render(
      <DeviceStatusPanel connected history={history} loading={false} status={status} windowEndMs={910_000} />,
    );
    for (const chart of container.querySelectorAll(".metric-sparkline")) {
      expect(chart.querySelectorAll("circle")).toHaveLength(2);
      expect(chart.querySelector("polyline")).toBeNull();
    }
  });
});
