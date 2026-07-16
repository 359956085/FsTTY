import {
  Ban,
  Clipboard,
  ChevronLeft,
  ChevronRight,
  Download,
  FileQuestion,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../../shared/api/types";
import type { TransferProgress } from "./useSessionConnections";
import { ContextMenu } from "../../shared/ui/ContextMenu";

interface FilesPaneProps {
  currentPath: string;
  files: FileEntry[];
  loading: boolean;
  sftpAvailable: boolean;
  transfer: TransferProgress | null;
  onCancelTransfer: () => void;
  onDismissTransfer: () => void;
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
  onDismissTransfer,
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null);
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

  async function copyPath(path: string) {
    await navigator.clipboard.writeText(path).catch(() => undefined);
  }

  return (
    <section className="files-panel" onContextMenu={(event) => event.preventDefault()}>
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
              }}
              onDoubleClick={() => file.kind === "folder" && onOpenPath(file.path)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedPath(file.path);
                setContextMenu({ x: event.clientX, y: event.clientY, file });
              }}
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

      {contextMenu ? (
        <ContextMenu
          items={[
            ...(contextMenu.file.kind === "folder"
              ? [{ id: "open", label: t("sessions.contextOpenFolder"), icon: <FolderOpen size={15} />, onSelect: () => onOpenPath(contextMenu.file.path) }]
              : [{ id: "download", label: t("sessions.download"), icon: <Download size={15} />, disabled: transferRunning, onSelect: () => onDownload(contextMenu.file) }]),
            { id: "copy", label: t("sessions.contextCopyPath"), icon: <Clipboard size={15} />, onSelect: () => void copyPath(contextMenu.file.path) },
            { id: "refresh", label: t("sessions.refresh"), icon: <RefreshCw size={15} />, disabled: loading, onSelect: onRefresh },
          ]}
          onClose={() => setContextMenu(null)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}

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
          ) : (
            <button
              aria-label={t("sessions.close")}
              onClick={onDismissTransfer}
              type="button"
            >
              <X size={15} />
            </button>
          )}
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
