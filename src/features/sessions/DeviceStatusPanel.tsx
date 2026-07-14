import { Cpu, HardDrive, MemoryStick, MonitorCog } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceStatus } from "../../shared/api/types";

interface DeviceStatusPanelProps {
  status: DeviceStatus | null;
}

export function DeviceStatusPanel({ status }: DeviceStatusPanelProps) {
  const { t } = useTranslation();

  return (
    <section className="status-panel">
      <header className="panel-title">
        <h2>{t("sessions.deviceStatus")}</h2>
      </header>

      {status ? (
        <div className="device-metrics">
          <MetricRow
            detail={t("sessions.cores", { count: status.cpuCores })}
            icon={<Cpu size={18} />}
            label={t("sessions.cpu")}
            percent={status.cpuPercent}
            value={`${status.cpuPercent}%`}
          />
          <MetricRow
            detail={`${status.memoryUsedGb} / ${status.memoryTotalGb} GB`}
            icon={<MemoryStick size={18} />}
            label={t("sessions.memory")}
            percent={status.memoryPercent}
            value={`${status.memoryPercent}%`}
          />
          <MetricRow
            detail={`${status.diskUsedGb} / ${status.diskTotalGb} GB`}
            icon={<HardDrive size={18} />}
            label={t("sessions.disk")}
            percent={status.diskPercent}
            value={`${status.diskPercent}%`}
          />
          <div className="device-row device-os-row">
            <MonitorCog size={18} />
            <span>{t("sessions.os")}</span>
            <strong>{status.os} ({t("sessions.bit64")})</strong>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface MetricRowProps {
  icon: ReactNode;
  label: string;
  percent: number;
  value: string;
  detail: string;
}

function MetricRow({ detail, icon, label, percent, value }: MetricRowProps) {
  return (
    <div className="device-row">
      {icon}
      <span>{label}</span>
      <span className="metric-track">
        <span style={{ width: `${percent}%` }} />
      </span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}
