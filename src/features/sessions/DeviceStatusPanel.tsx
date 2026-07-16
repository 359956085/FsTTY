import { Cpu, HardDrive, MemoryStick, MonitorCog } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceStatus } from "../../shared/api/types";

interface DeviceStatusPanelProps {
  status: DeviceStatus | null;
  connected: boolean;
}

export function DeviceStatusPanel({ connected, status }: DeviceStatusPanelProps) {
  const { t } = useTranslation();

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
            percent={status.cpuPercent}
          />
          <MetricRow
            detail={formatCapacity(status.memoryUsedGb, status.memoryTotalGb)}
            icon={<MemoryStick size={18} />}
            label={t("sessions.memory")}
            percent={status.memoryPercent}
          />
          <MetricRow
            detail={formatCapacity(status.diskUsedGb, status.diskTotalGb)}
            icon={<HardDrive size={18} />}
            label={t("sessions.disk")}
            percent={status.diskPercent}
          />
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
}

function MetricRow({ detail, icon, label, percent }: MetricRowProps) {
  const safePercent = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="device-row">
      {icon}
      <span>{label}</span>
      <span className="metric-track">
        <span style={{ width: `${safePercent}%` }} />
      </span>
      <strong>{percent == null ? "--" : `${percent}%`}</strong>
      <em>{detail}</em>
    </div>
  );
}

function formatCapacity(used?: number | null, total?: number | null) {
  if (used == null || total == null) {
    return "--";
  }
  return `${used.toFixed(1)} / ${total.toFixed(1)} GB`;
}
