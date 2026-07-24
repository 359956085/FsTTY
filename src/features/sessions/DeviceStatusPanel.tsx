import {
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  MemoryStick,
  MonitorCog,
  Network,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceStatus } from "../../shared/api/types";
import {
  buildSparklineSegments,
  formatNetworkRate,
  type DeviceMetricSample,
} from "./deviceMetrics";

interface DeviceStatusPanelProps {
  status: DeviceStatus | null;
  history: readonly DeviceMetricSample[];
  connected: boolean;
}

export function DeviceStatusPanel({ connected, history, status }: DeviceStatusPanelProps) {
  const { t } = useTranslation();
  const latestSample = history[history.length - 1];
  const chartWindowEndMs = Math.max(latestSample?.sampledAtMs ?? 0, performance.now());

  return (
    <section className="status-panel">
      <header className="panel-title">
        <h2>{t("sessions.deviceStatus")}</h2>
      </header>

      {status?.available ? (
        <div className="device-metrics">
          <MetricRow
            detail={
              status.cpuCores == null
                ? "--"
                : t("sessions.cores", { count: status.cpuCores })
            }
            icon={<Cpu size={18} />}
            label={t("sessions.cpu")}
            history={history}
            metric="cpuPercent"
            percent={status.cpuPercent}
            windowEndMs={chartWindowEndMs}
          />
          <MetricRow
            detail={formatCapacity(status.memoryUsedGb, status.memoryTotalGb)}
            icon={<MemoryStick size={18} />}
            label={t("sessions.memory")}
            history={history}
            metric="memoryPercent"
            percent={status.memoryPercent}
            windowEndMs={chartWindowEndMs}
          />
          <MetricRow
            detail={formatCapacity(status.diskUsedGb, status.diskTotalGb)}
            icon={<HardDrive size={18} />}
            label={t("sessions.disk")}
            percent={status.diskPercent}
          />
          <div className="device-row device-network-row">
            <Network size={18} />
            <span>{t("sessions.network")}</span>
            <span className="network-rates">
              <span title={t("sessions.networkUpload")}>
                <ArrowUp aria-hidden="true" size={14} />
                {formatNetworkRate(latestSample?.networkUploadBytesPerSecond)}
              </span>
              <span title={t("sessions.networkDownload")}>
                <ArrowDown aria-hidden="true" size={14} />
                {formatNetworkRate(latestSample?.networkDownloadBytesPerSecond)}
              </span>
            </span>
          </div>
          <div className="device-row device-os-row">
            <MonitorCog size={18} />
            <span>{t("sessions.os")}</span>
            <strong
              title={`${status.os ?? "--"}${status.architecture ? ` (${status.architecture})` : ""}`}
            >
              {status.os ?? "--"}
              {status.architecture ? ` (${status.architecture})` : ""}
            </strong>
          </div>
        </div>
      ) : (
        <p className="empty-message">
          {connected
            ? t("sessions.deviceUnavailable")
            : t("sessions.connectForDevice")}
        </p>
      )}
    </section>
  );
}

interface MetricRowProps {
  icon: ReactNode;
  label: string;
  percent?: number | null;
  detail: string;
  history?: readonly DeviceMetricSample[];
  metric?: "cpuPercent" | "memoryPercent";
  windowEndMs?: number;
}

function MetricRow({
  detail,
  history,
  icon,
  label,
  metric,
  percent,
  windowEndMs,
}: MetricRowProps) {
  const safePercent = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="device-row">
      {icon}
      <span>{label}</span>
      {history && metric ? (
        <MetricSparkline
          history={history}
          label={`${label} ${percent == null ? "--" : `${percent}%`}`}
          metric={metric}
          windowEndMs={windowEndMs}
        />
      ) : (
        <span className="metric-track">
          <span style={{ width: `${safePercent}%` }} />
        </span>
      )}
      <strong>{percent == null ? "--" : `${percent}%`}</strong>
      <em>{detail}</em>
    </div>
  );
}

function MetricSparkline({
  history,
  label,
  metric,
  windowEndMs,
}: {
  history: readonly DeviceMetricSample[];
  label: string;
  metric: "cpuPercent" | "memoryPercent";
  windowEndMs?: number;
}) {
  const segments = buildSparklineSegments(history, metric, 120, 24, windowEndMs);
  return (
    <svg
      aria-label={label}
      className="metric-sparkline"
      preserveAspectRatio="none"
      role="img"
      viewBox="0 0 120 24"
    >
      {segments.map((segment, index) =>
        segment.length === 1 ? (
          <circle
            cx={segment[0].x}
            cy={segment[0].y}
            key={`${index}-point`}
            r="1.5"
          />
        ) : (
          <polyline
            key={`${index}-line`}
            points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
          />
        ),
      )}
    </svg>
  );
}

function formatCapacity(used?: number | null, total?: number | null) {
  if (used == null || total == null) {
    return "--";
  }
  return `${used.toFixed(1)} / ${total.toFixed(1)} GB`;
}
