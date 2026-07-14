import {
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../../shared/api/types";

type DetailTab = "details" | "permissions" | "preview";

interface FilesPaneProps {
  currentPath: string;
  files: FileEntry[];
  loading: boolean;
  onCollapse: () => void;
  onOpenPath: (path: string) => void;
  onRefresh: () => void;
}

export function FilesPane({
  currentPath,
  files,
  loading,
  onCollapse,
  onOpenPath,
  onRefresh,
}: FilesPaneProps) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("details");

  useEffect(() => {
    setSelectedPath((current) => {
      if (current && files.some((file) => file.path === current)) {
        return current;
      }

      return files.find((file) => file.name === "index.html")?.path ?? files[0]?.path ?? null;
    });
  }, [files]);

  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);
  const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";

  return (
    <section className="files-panel">
      <header className="panel-title">
        <h2>{t("sessions.files")}</h2>
        <button
          aria-label={t("sessions.collapse")}
          className="icon-button"
          onClick={onCollapse}
          type="button"
        >
          <ChevronRight size={18} />
        </button>
      </header>

      <div className="file-toolbar">
        <button
          aria-label={t("sessions.back")}
          className="breadcrumb-icon"
          disabled={currentPath === "/"}
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
              <button onClick={() => onOpenPath(item.path)} type="button">
                {item.label}
              </button>
            </span>
          ))}
        </nav>
        <button
          aria-label={t("sessions.refresh")}
          className="breadcrumb-icon"
          disabled={loading}
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
        {files.map((file) => {
          const Icon = file.kind === "folder" ? Folder : file.name.endsWith(".html") ? FileCode2 : FileText;

          return (
            <button
              className={selected?.path === file.path ? "file-row file-row-active" : "file-row"}
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
              <span>{file.modified}</span>
              <span>{file.permissions.split(" ")[0]}</span>
            </button>
          );
        })}
      </div>

      {selected ? (
        <section className="file-details">
          <div className="file-details-title">
            {selected.kind === "folder" ? <Folder size={20} /> : <FileCode2 size={20} />}
            <strong>{selected.name}</strong>
          </div>

          <div className="detail-tabs" role="tablist">
            {(["details", "permissions", "preview"] as const).map((tab) => (
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
                  : `${formatSize(selected.size)} (${t("sessions.bytes", { count: selected.size.toLocaleString() })})`}
              </dd>
              <dt>{t("sessions.type")}</dt>
              <dd>
                {selected.kind === "folder"
                  ? t("sessions.folder")
                  : t("sessions.document", {
                      extension: selected.name.split(".").pop()?.toUpperCase() ?? t("sessions.file"),
                    })}
              </dd>
              <dt>{t("sessions.modified")}</dt>
              <dd>{selected.modified}</dd>
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
          {detailTab === "preview" ? (
            <p className="preview-message">{t("sessions.previewUnavailable")}</p>
          ) : null}
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
