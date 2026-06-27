import { Activity, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceStatus } from "../../shared/api/types";

interface DeviceStatusPanelProps {
  status: DeviceStatus | null;
}

export function DeviceStatusPanel({ status }: DeviceStatusPanelProps) {
  const { t } = useTranslation();

  if (!status) {
    return null;
  }

  return (
    <section className="status-panel">
      <header className="panel-title">
        <h2>{status.ip}</h2>
        <span>{status.username}</span>
      </header>

      <div className="status-metrics">
        <Metric icon={<Cpu size={17} />} label={t("sessions.cpu")} value={status.cpuPercent} />
        <Metric icon={<MemoryStick size={17} />} label={t("sessions.memory")} value={status.memoryPercent} />
        <Metric icon={<HardDrive size={17} />} label={t("sessions.disk")} value={status.diskPercent} />
      </div>

      <dl className="details-list compact">
        <dt>{t("sessions.os")}</dt>
        <dd>{status.os}</dd>
        <dt>{t("sessions.uptime")}</dt>
        <dd>{status.uptime}</dd>
      </dl>

      <div className="service-list">
        {status.services.map((service) => (
          <div className="service-row" key={service.name}>
            <Activity size={15} />
            <span>{service.name}</span>
            <strong>{service.state}</strong>
            <em>{service.port}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

interface MetricProps {
  icon: React.ReactNode;
  label: string;
  value: number;
}

function Metric({ icon, label, value }: MetricProps) {
  return (
    <div className="metric">
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}%</strong>
      <span className="metric-track">
        <span style={{ width: `${value}%` }} />
      </span>
    </div>
  );
}

