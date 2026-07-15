import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FileQuestion,
  FileText,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../../shared/api/types";
import type { TransferProgress } from "./useSessionConnections";

type DetailTab = "details" | "permissions";

interface FilesPaneProps {
  currentPath: string;
  files: FileEntry[];
  loading: boolean;
  sftpAvailable: boolean;
  transfer: TransferProgress | null;
  onCancelTransfer: () => void;
  onCollapse: () => void;
  onDownload: (file: FileEntry) => void;
  onOpenPath: (path: string) => void;
  onRefresh: () => void;
  onUpload: () => void;
}

export function FilesPane({
  currentPath,
  files,
  loading,
  onCancelTransfer,
  onCollapse,
  onDownload,
  onOpenPath,
  onRefresh,
  onUpload,
  sftpAvailable,
  transfer,
}: FilesPaneProps) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("details");
  const transferRunning = transfer?.state === "running";

  useEffect(() => {
    setSelectedPath((current) => {
      if (current && files.some((file) => file.path === current)) {
        return current;
      }
      return files[0]?.path ?? null;
    });
  }, [files]);

  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);
  const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
  const progressPercent = transfer?.totalBytes
    ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100))
    : 0;

  return (
    <section className="files-panel">
      <header className="panel-title">
        <h2>{t("sessions.files")}</h2>
        <span className="panel-title-actions">
          <button
            aria-label={t("sessions.upload")}
            className="icon-button"
            disabled={!sftpAvailable || loading || transferRunning}
            onClick={onUpload}
            type="button"
          >
            <Upload size={17} />
          </button>
          <button
            aria-label={t("sessions.collapse")}
            className="icon-button"
            onClick={onCollapse}
            type="button"
          >
            <ChevronRight size={18} />
          </button>
        </span>
      </header>

      <div className="file-toolbar">
        <button
          aria-label={t("sessions.back")}
          className="breadcrumb-icon"
          disabled={!sftpAvailable || currentPath === "/"}
          onClick={() => onOpenPath(parentPath)}
          type="button"
        >
          <ChevronLeft size={16} />
        </button>
        <FolderOpen size={17} />
        <nav aria-label={t("sessions.path")} className="breadcrumb">
          {breadcrumbs.map((item, index) => (
            <span key={item.path}>
              {index > 0 ? <ChevronRight size={13} /> : null}
              <button
                disabled={!sftpAvailable}
                onClick={() => onOpenPath(item.path)}
                type="button"
              >
                {item.label}
              </button>
            </span>
          ))}
        </nav>
        <button
          aria-label={t("sessions.refresh")}
          className="breadcrumb-icon"
          disabled={!sftpAvailable || loading}
          onClick={onRefresh}
          type="button"
        >
          <RefreshCw className={loading ? "spin" : ""} size={16} />
        </button>
      </div>

      <div className="file-table">
        <div className="file-row file-head">
          <span>{t("sessions.name")}</span>
          <span>{t("sessions.size")}</span>
          <span>{t("sessions.modified")}</span>
          <span>{t("sessions.permissions")}</span>
        </div>
        {!sftpAvailable ? (
          <p className="empty-message">{t("sessions.sftpUnavailable")}</p>
        ) : null}
        {sftpAvailable && !loading && files.length === 0 ? (
          <p className="empty-message">{t("sessions.emptyDirectory")}</p>
        ) : null}
        {files.map((file) => {
          const Icon = fileIcon(file);
          return (
            <button
              className={
                selected?.path === file.path ? "file-row file-row-active" : "file-row"
              }
              key={file.path}
              onClick={() => {
                setSelectedPath(file.path);
                setDetailTab("details");
              }}
              onDoubleClick={() => file.kind === "folder" && onOpenPath(file.path)}
              type="button"
            >
              <span>
                <Icon size={16} />
                {file.name}
              </span>
              <span>{file.size == null ? "--" : formatSize(file.size)}</span>
              <span>{formatModifiedTime(file.modifiedAt)}</span>
              <span>{file.permissions.split(" ")[0]}</span>
            </button>
          );
        })}
      </div>

      {transfer ? (
        <section className={`transfer-bar transfer-${transfer.state}`}>
          <span>
            {transfer.direction === "upload" ? <Upload size={15} /> : <Download size={15} />}
            <strong>{transfer.fileName}</strong>
          </span>
          <span className="transfer-track">
            <span style={{ width: `${progressPercent}%` }} />
          </span>
          <em>
            {transfer.state === "completed"
              ? t("sessions.transferCompleted")
              : transfer.state === "cancelled"
                ? t("sessions.transferCancelled")
                : `${progressPercent}%`}
          </em>
          {transferRunning ? (
            <button
              aria-label={t("sessions.cancelTransfer")}
              onClick={onCancelTransfer}
              type="button"
            >
              <Ban size={15} />
            </button>
          ) : null}
        </section>
      ) : null}

      {selected ? (
        <section className="file-details">
          <div className="file-details-title">
            {selected.kind === "folder" ? <Folder size={20} /> : <FileCode2 size={20} />}
            <strong>{selected.name}</strong>
            {selected.kind === "file" ? (
              <button
                aria-label={t("sessions.download")}
                className="file-download-button"
                disabled={transferRunning}
                onClick={() => onDownload(selected)}
                type="button"
              >
                <Download size={15} />
                {t("sessions.download")}
              </button>
            ) : null}
          </div>

          <div className="detail-tabs" role="tablist">
            {(["details", "permissions"] as const).map((tab) => (
              <button
                aria-selected={detailTab === tab}
                className={detailTab === tab ? "detail-tab-active" : ""}
                key={tab}
                onClick={() => setDetailTab(tab)}
                role="tab"
                type="button"
              >
                {t(`sessions.${tab}`)}
              </button>
            ))}
          </div>

          {detailTab === "details" ? (
            <dl className="details-list">
              <dt>{t("sessions.size")}</dt>
              <dd>
                {selected.size == null
                  ? "--"
                  : `${formatSize(selected.size)} (${selected.size.toLocaleString()} ${t("sessions.bytesUnit")})`}
              </dd>
              <dt>{t("sessions.type")}</dt>
              <dd>{t(`sessions.fileKind.${selected.kind}`)}</dd>
              <dt>{t("sessions.modified")}</dt>
              <dd>{formatModifiedTime(selected.modifiedAt)}</dd>
              <dt>{t("sessions.permissions")}</dt>
              <dd>{selected.permissions}</dd>
              <dt>{t("sessions.owner")}</dt>
              <dd>{selected.owner}</dd>
              <dt>{t("sessions.group")}</dt>
              <dd>{selected.group}</dd>
            </dl>
          ) : null}
          {detailTab === "permissions" ? (
            <dl className="details-list">
              <dt>{t("sessions.owner")}</dt>
              <dd>{selected.owner}</dd>
              <dt>{t("sessions.group")}</dt>
              <dd>{selected.group}</dd>
              <dt>{t("sessions.permissions")}</dt>
              <dd>{selected.permissions}</dd>
            </dl>
          ) : null}
      </section>
      ) : null}
    </section>
  );
}

function fileIcon(file: FileEntry) {
  if (file.kind === "folder") {
    return Folder;
  }
  if (file.kind === "symlink") {
    return LinkIcon;
  }
  if (file.kind === "other") {
    return FileQuestion;
  }
  return file.name.endsWith(".html") ? FileCode2 : FileText;
}

function formatSize(size: number) {
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

function formatModifiedTime(value?: number | null) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function buildBreadcrumbs(path: string) {
  const segments = path.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...segments.map((segment, index) => ({
      label: segment,
      path: `/${segments.slice(0, index + 1).join("/")}`,
    })),
  ];
}
