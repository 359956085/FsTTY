import { FileText, Folder, MoreHorizontal, RefreshCw, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../../shared/api/types";

interface FilesPaneProps {
  files: FileEntry[];
  sessionName: string;
}

export function FilesPane({ files, sessionName }: FilesPaneProps) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? files[0] ?? null,
    [files, selectedPath],
  );

  return (
    <section className="files-panel">
      <header className="panel-title">
        <h2>
          {t("sessions.files")} · {sessionName}
        </h2>
        <div className="panel-actions">
          <RefreshCw size={16} />
          <Upload size={16} />
          <MoreHorizontal size={16} />
        </div>
      </header>

      <div className="breadcrumb">
        <span>/</span>
        <span>var</span>
        <span>www</span>
        <span>app</span>
      </div>

      <div className="file-table">
        <div className="file-row file-head">
          <span>{t("sessions.name")}</span>
          <span>{t("sessions.size")}</span>
          <span>{t("sessions.modified")}</span>
        </div>
        {files.map((file) => {
          const Icon = file.kind === "folder" ? Folder : FileText;
          return (
            <button
              className={selected?.path === file.path ? "file-row file-row-active" : "file-row"}
              key={file.path}
              onClick={() => setSelectedPath(file.path)}
              type="button"
            >
              <span>
                <Icon size={17} />
                {file.name}
              </span>
              <span>{file.size ? formatSize(file.size) : "-"}</span>
              <span>{file.modified}</span>
            </button>
          );
        })}
      </div>

      {selected ? (
        <section className="file-details">
          <div className="file-details-title">
            {selected.kind === "folder" ? <Folder size={34} /> : <FileText size={34} />}
            <div>
              <strong>{selected.name}</strong>
              <span>{selected.kind === "folder" ? t("sessions.folder") : t("sessions.file")}</span>
            </div>
          </div>

          <div className="detail-tabs">
            <span className="detail-tab-active">{t("sessions.details")}</span>
            <span>{t("sessions.permissions")}</span>
            <span>{t("sessions.preview")}</span>
          </div>

          <dl className="details-list">
            <dt>{t("sessions.path")}</dt>
            <dd>{selected.path}</dd>
            <dt>{t("sessions.size")}</dt>
            <dd>{selected.size ? formatSize(selected.size) : "-"}</dd>
            <dt>{t("sessions.modified")}</dt>
            <dd>{selected.modified}</dd>
            <dt>{t("sessions.owner")}</dt>
            <dd>{selected.owner}</dd>
            <dt>{t("sessions.group")}</dt>
            <dd>{selected.group}</dd>
            <dt>{t("sessions.permissions")}</dt>
            <dd>{selected.permissions}</dd>
          </dl>
        </section>
      ) : null}
    </section>
  );
}

function formatSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  return `${(size / 1024).toFixed(1)} KB`;
}

