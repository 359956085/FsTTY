import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  FolderPlus,
  Link as LinkIcon,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { FileEntry } from "../../shared/api/types";
import { resolveApiError } from "../../shared/api/errors";
import { Button } from "../../shared/ui/Button";
import type { TransferProgress } from "./useSessionConnections";
import { ContextMenu } from "../../shared/ui/ContextMenu";
import { TextInput } from "../../shared/ui/TextInput";
import { ResizeHandle } from "./ResizeHandle";
import {
  FILE_COLUMN_LIMITS,
  readWorkspacePreferences,
  updateWorkspacePreferences,
  type FileColumnPreferences,
} from "./workspacePreferences";

type ResizableFileColumn = "name" | "size" | "modified";

const FILE_COLUMN_KEYBOARD_STEP = 8;
const REMOTE_ENTRY_DRAG_THRESHOLD = 5;

function clampFileColumn(column: ResizableFileColumn, value: number) {
  const limits = FILE_COLUMN_LIMITS[column];
  return Math.min(Math.max(value, limits.min), limits.max);
}

function applyFileColumnWidth(
  table: HTMLDivElement | null,
  column: keyof FileColumnPreferences,
  value: number,
) {
  table?.style.setProperty(`--file-column-${column}`, `${value}px`);
}

interface FilesPaneProps {
  currentPath: string;
  files: FileEntry[];
  loading: boolean;
  sftpAvailable: boolean;
  transfer: TransferProgress | null;
  onCancelTransfer: () => void;
  onDismissTransfer: () => void;
  onCollapse: () => void;
  onCreateDirectory: (name: string) => Promise<void>;
  onDeleteEntry: (path: string) => Promise<void>;
  onDownload: (file: FileEntry) => void;
  onMoveEntry: (sourcePath: string, targetDirectory: string) => Promise<void>;
  onOpenPath: (path: string) => void;
  onRefresh: () => void;
  onRenameEntry: (path: string, newName: string) => Promise<void>;
  onUpload: () => void;
  onUploadFiles: (localPaths: string[]) => void;
}

type FileContextMenu =
  | { kind: "directory"; x: number; y: number }
  | { kind: "entry"; x: number; y: number; file: FileEntry };

type FileOperationDialog =
  | { kind: "create"; value: string; error: string | null }
  | { kind: "rename"; file: FileEntry; value: string; error: string | null }
  | { kind: "delete"; file: FileEntry; error: string | null };

interface RemoteEntryDrag {
  source: FileEntry;
  targetDirectory: string | null;
}

interface RemoteEntryPointerDrag extends RemoteEntryDrag {
  captureTarget: HTMLButtonElement;
  dragging: boolean;
  pointerId: number;
  startX: number;
  startY: number;
}

type RemoteMoveStatus =
  | { kind: "moving" | "success"; sourceName: string; targetDirectory: string }
  | { kind: "error"; message: string };

export function FilesPane({
  currentPath,
  files,
  loading,
  onCancelTransfer,
  onDismissTransfer,
  onCollapse,
  onCreateDirectory,
  onDeleteEntry,
  onDownload,
  onMoveEntry,
  onOpenPath,
  onRefresh,
  onRenameEntry,
  onUpload,
  onUploadFiles,
  sftpAvailable,
  transfer,
}: FilesPaneProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [fileColumns, setFileColumns] = useState<FileColumnPreferences>(
    () => readWorkspacePreferences().fileColumns,
  );
  const fileColumnsRef = useRef(fileColumns);
  const removeColumnDragListenersRef = useRef<() => void>(() => undefined);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [fileOperation, setFileOperation] = useState<FileOperationDialog | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [dragUploadActive, setDragUploadActive] = useState(false);
  const [remoteDrag, setRemoteDrag] = useState<RemoteEntryDrag | null>(null);
  const remotePointerDragRef = useRef<RemoteEntryPointerDrag | null>(null);
  const suppressRemoteClickRef = useRef(false);
  const moveOperationIdRef = useRef(0);
  const moveSuccessTimerRef = useRef<number | null>(null);
  const [moveStatus, setMoveStatus] = useState<RemoteMoveStatus | null>(null);
  const transferRunning = transfer?.state === "running";
  const movePending = moveStatus?.kind === "moving";
  const operationBlocked =
    !sftpAvailable ||
    loading ||
    transferRunning ||
    operationPending ||
    movePending ||
    fileOperation !== null;
  const dragUploadRef = useRef({ enabled: !operationBlocked, onUploadFiles });
  dragUploadRef.current = { enabled: !operationBlocked, onUploadFiles };

  useLayoutEffect(() => {
    fileColumnsRef.current = fileColumns;
    for (const [column, value] of Object.entries(fileColumns)) {
      applyFileColumnWidth(
        tableRef.current,
        column as keyof FileColumnPreferences,
        value,
      );
    }
  }, [fileColumns]);

  useEffect(
    () => () => {
      removeColumnDragListenersRef.current();
    },
    [],
  );

  useEffect(() => {
    if (operationBlocked) {
      finishRemoteDrag();
    }
  }, [operationBlocked]);

  useEffect(() => {
    finishRemoteDrag();
    clearMoveFeedback();
  }, [currentPath, sftpAvailable]);

  useEffect(() => {
    let disposed = false;
    let removeDragDropListener: () => void = () => undefined;
    let removeScaleListener: () => void = () => undefined;
    const handleWindowBlur = () => finishRemoteDrag();
    window.addEventListener("blur", handleWindowBlur);

    void (async () => {
      const appWindow = getCurrentWindow();
      // Tauri 提供物理坐标，DOM 使用逻辑坐标；监听缩放变化避免跨屏后命中错误。
      let scaleFactor = await appWindow.scaleFactor();
      const stopScaleListener = await appWindow.onScaleChanged((event) => {
        scaleFactor = event.payload.scaleFactor;
      });
      if (disposed) {
        stopScaleListener();
        return;
      }
      removeScaleListener = stopScaleListener;
      const stopDragDropListener = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragUploadActive(false);
          return;
        }

        const position = payload.position.toLogical(scaleFactor);
        const bounds = panelRef.current?.getBoundingClientRect();
        const inside = Boolean(
          bounds &&
            position.x >= bounds.left &&
            position.x <= bounds.right &&
            position.y >= bounds.top &&
            position.y <= bounds.bottom,
        );
        const dragUpload = dragUploadRef.current;
        if (payload.type === "drop") {
          setDragUploadActive(false);
          if (inside && dragUpload.enabled && payload.paths.length > 0) {
            dragUpload.onUploadFiles(payload.paths);
          }
          return;
        }
        setDragUploadActive(inside && dragUpload.enabled);
      });

      if (disposed) {
        stopDragDropListener();
      } else {
        removeDragDropListener = stopDragDropListener;
      }
    })().catch(() => undefined);

    return () => {
      disposed = true;
      removeDragDropListener();
      removeScaleListener();
      window.removeEventListener("blur", handleWindowBlur);
      remotePointerDragRef.current = null;
      suppressRemoteClickRef.current = false;
      moveOperationIdRef.current += 1;
      if (moveSuccessTimerRef.current !== null) {
        window.clearTimeout(moveSuccessTimerRef.current);
        moveSuccessTimerRef.current = null;
      }
    };
  }, []);

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
  const operationTitle =
    fileOperation?.kind === "create"
      ? t("sessions.createDirectory")
      : fileOperation?.kind === "rename"
        ? t("sessions.renameRemoteEntry")
        : t("sessions.deleteRemoteEntry");

  async function copyPath(path: string) {
    await navigator.clipboard.writeText(path).catch(() => undefined);
  }

  function clearMoveFeedback() {
    moveOperationIdRef.current += 1;
    if (moveSuccessTimerRef.current !== null) {
      window.clearTimeout(moveSuccessTimerRef.current);
      moveSuccessTimerRef.current = null;
    }
    setMoveStatus(null);
  }

  function finishRemoteDrag() {
    const drag = remotePointerDragRef.current;
    remotePointerDragRef.current = null;
    if (drag?.captureTarget.hasPointerCapture(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture(drag.pointerId);
    }
    setRemoteDrag(null);
    setDragUploadActive(false);
  }

  function beginRemotePointerDrag(
    file: FileEntry,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      operationBlocked ||
      !isRemoteMoveCandidate(file)
    ) {
      return;
    }
    setSelectedPath(file.path);
    setDragUploadActive(false);
    suppressRemoteClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    remotePointerDragRef.current = {
      source: file,
      targetDirectory: null,
      captureTarget: event.currentTarget,
      dragging: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }

  function updateRemotePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = remotePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (!drag.dragging) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < REMOTE_ENTRY_DRAG_THRESHOLD) {
        return;
      }
      clearMoveFeedback();
      drag.dragging = true;
      setRemoteDrag({ source: drag.source, targetDirectory: null });
    }

    event.preventDefault();
    const targetDirectory = findRemoteDropTarget(
      event.clientX,
      event.clientY,
      drag.source,
      panelRef.current,
    );
    if (drag.targetDirectory === targetDirectory) {
      return;
    }
    drag.targetDirectory = targetDirectory;
    setRemoteDrag({ source: drag.source, targetDirectory });
  }

  function finishRemotePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = remotePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const { dragging, source, targetDirectory } = drag;
    finishRemoteDrag();
    if (!dragging) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressRemoteClickRef.current = true;
    window.setTimeout(() => {
      suppressRemoteClickRef.current = false;
    }, 0);
    if (!targetDirectory) {
      return;
    }

    const operationId = moveOperationIdRef.current + 1;
    moveOperationIdRef.current = operationId;
    setMoveStatus({
      kind: "moving",
      sourceName: source.name,
      targetDirectory,
    });
    void onMoveEntry(source.path, targetDirectory)
      .then(() => {
        if (moveOperationIdRef.current !== operationId) {
          return;
        }
        setMoveStatus({
          kind: "success",
          sourceName: source.name,
          targetDirectory,
        });
        moveSuccessTimerRef.current = window.setTimeout(() => {
          if (moveOperationIdRef.current === operationId) {
            setMoveStatus(null);
          }
          moveSuccessTimerRef.current = null;
        }, 2500);
      })
      .catch((error) => {
        if (moveOperationIdRef.current === operationId) {
          setMoveStatus({
            kind: "error",
            message: resolveApiError(error, t("sessions.moveRemoteEntryFailed")),
          });
        }
      });
  }

  function updateOperationValue(value: string) {
    setFileOperation((current) =>
      current && current.kind !== "delete" ? { ...current, value, error: null } : current,
    );
  }

  async function submitFileOperation() {
    if (!fileOperation || operationPending) {
      return;
    }
    if (fileOperation.kind !== "delete" && !fileOperation.value.trim()) {
      setFileOperation({ ...fileOperation, error: t("sessions.remoteNameRequired") });
      return;
    }

    setOperationPending(true);
    setFileOperation({ ...fileOperation, error: null });
    try {
      if (fileOperation.kind === "create") {
        await onCreateDirectory(fileOperation.value.trim());
      } else if (fileOperation.kind === "rename") {
        await onRenameEntry(fileOperation.file.path, fileOperation.value.trim());
      } else {
        await onDeleteEntry(fileOperation.file.path);
      }
      setFileOperation(null);
    } catch (error) {
      const message = resolveApiError(error, t("errors.unknown"));
      setFileOperation((current) => (current ? { ...current, error: message } : current));
    } finally {
      setOperationPending(false);
    }
  }

  const commitFileColumn = useCallback(
    (column: ResizableFileColumn, value: number) => {
      const next = {
        ...fileColumnsRef.current,
        [column]: clampFileColumn(column, value),
      };
      fileColumnsRef.current = next;
      setFileColumns(next);
      updateWorkspacePreferences({ fileColumns: next });
    },
    [],
  );

  const beginFileColumnResize = useCallback(
    (column: ResizableFileColumn, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      removeColumnDragListenersRef.current();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = fileColumnsRef.current[column];
      handle.setPointerCapture(pointerId);

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("blur", handlePointerCancel);
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        removeColumnDragListenersRef.current = () => undefined;
      };

      const calculateWidth = (clientX: number) =>
        clampFileColumn(column, startWidth + clientX - startX);

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) {
          return;
        }
        pointerEvent.preventDefault();
        applyFileColumnWidth(tableRef.current, column, calculateWidth(pointerEvent.clientX));
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) {
          return;
        }
        const nextWidth = calculateWidth(pointerEvent.clientX);
        cleanup();
        commitFileColumn(column, nextWidth);
      };

      const handlePointerCancel = () => {
        applyFileColumnWidth(tableRef.current, column, fileColumnsRef.current[column]);
        cleanup();
      };

      removeColumnDragListenersRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove, { passive: false });
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("blur", handlePointerCancel);
    },
    [commitFileColumn],
  );

  const adjustFileColumn = useCallback(
    (column: ResizableFileColumn, direction: -1 | 1) => {
      commitFileColumn(
        column,
        fileColumnsRef.current[column] + direction * FILE_COLUMN_KEYBOARD_STEP,
      );
    },
    [commitFileColumn],
  );

  return (
    <section
      className={remoteDrag ? "files-panel remote-entry-dragging" : "files-panel"}
      onContextMenu={(event) => event.preventDefault()}
      ref={panelRef}
    >
      <header className="panel-title">
        <h2>{t("sessions.files")}</h2>
        <span className="panel-title-actions">
          <button
            aria-label={t("sessions.upload")}
            className="icon-button"
            disabled={operationBlocked}
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
                className={breadcrumbTargetClassName(item.path, remoteDrag, moveStatus)}
                data-remote-drop-path={item.path}
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

      {moveStatus?.kind === "moving" ? (
        <div className="file-move-notice" role="status">
          {t("sessions.movingRemoteEntry")}
        </div>
      ) : moveStatus?.kind === "success" ? (
        <div className="file-move-notice file-move-success" role="status">
          {t("sessions.moveRemoteEntrySucceeded", { name: moveStatus.sourceName })}
        </div>
      ) : moveStatus?.kind === "error" ? (
        <div className="file-move-notice file-move-error" role="alert">
          <span>{moveStatus.message}</span>
          <button
            aria-label={t("sessions.close")}
            onClick={clearMoveFeedback}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      <div
        className="file-table"
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ kind: "directory", x: event.clientX, y: event.clientY });
        }}
        ref={tableRef}
      >
        <div className="file-row file-head">
          {(["name", "size", "modified"] as const).map((column) => {
            const limits = FILE_COLUMN_LIMITS[column];
            const label = t(`sessions.${column}`);
            return (
              <span className="file-head-cell" key={column}>
                <span className="file-head-label">{label}</span>
                <ResizeHandle
                  ariaLabel={t("sessions.resizeFileColumn", { column: label })}
                  className="file-column-resizer"
                  onKeyboardResize={(direction) => adjustFileColumn(column, direction)}
                  onPointerDown={(event) => beginFileColumnResize(column, event)}
                  orientation="vertical"
                  valueMax={limits.max}
                  valueMin={limits.min}
                  valueNow={fileColumns[column]}
                />
              </span>
            );
          })}
          <span className="file-head-cell">
            <span className="file-head-label">{t("sessions.permissions")}</span>
          </span>
        </div>
        {!sftpAvailable ? (
          <p className="empty-message">{t("sessions.sftpUnavailable")}</p>
        ) : null}
        {sftpAvailable && !loading && files.length === 0 ? (
          <p className="empty-message">{t("sessions.emptyDirectory")}</p>
        ) : null}
        {files.map((file) => {
          const Icon = fileIcon(file);
          const size = file.size == null ? "--" : formatSize(file.size);
          const modified = formatModifiedTime(file.modifiedAt);
          const permissions = file.permissions.split(" ")[0];
          return (
            <button
              className={fileRowClassName(
                file,
                selected?.path,
                remoteDrag,
                moveStatus,
                !operationBlocked,
              )}
              data-remote-drop-path={file.kind === "folder" ? file.path : undefined}
              key={file.path}
              onClick={(event) => {
                if (suppressRemoteClickRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                setSelectedPath(file.path);
              }}
              onDoubleClick={(event) => {
                if (suppressRemoteClickRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (file.kind === "folder") {
                  onOpenPath(file.path);
                }
              }}
              onLostPointerCapture={finishRemoteDrag}
              onPointerCancel={finishRemoteDrag}
              onPointerDown={(event) => beginRemotePointerDrag(file, event)}
              onPointerMove={updateRemotePointerDrag}
              onPointerUp={finishRemotePointerDrag}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedPath(file.path);
                setContextMenu({
                  kind: "entry",
                  x: event.clientX,
                  y: event.clientY,
                  file,
                });
              }}
              type="button"
            >
              <span title={file.name}>
                <Icon size={16} />
                {file.name}
              </span>
              <span title={size}>{size}</span>
              <span title={modified}>{modified}</span>
              <span title={permissions}>{permissions}</span>
            </button>
          );
        })}
      </div>

      {dragUploadActive ? (
        <div className="file-drop-overlay">
          <Upload size={28} />
          <strong>{t("sessions.dropFilesToUpload")}</strong>
          <span>{currentPath}</span>
        </div>
      ) : null}

      {contextMenu ? (
        <ContextMenu
          items={
            contextMenu.kind === "directory"
              ? [
                  {
                    id: "createDirectory",
                    label: t("sessions.createDirectory"),
                    icon: <FolderPlus size={15} />,
                    disabled: operationBlocked,
                    onSelect: () =>
                      setFileOperation({ kind: "create", value: "", error: null }),
                  },
                  {
                    id: "upload",
                    label: t("sessions.upload"),
                    icon: <Upload size={15} />,
                    disabled: operationBlocked,
                    onSelect: onUpload,
                  },
                  {
                    id: "refresh",
                    label: t("sessions.refresh"),
                    icon: <RefreshCw size={15} />,
                    disabled: !sftpAvailable || loading,
                    onSelect: onRefresh,
                  },
                ]
              : [
                  ...(contextMenu.file.kind === "folder"
                    ? [
                        {
                          id: "open",
                          label: t("sessions.contextOpenFolder"),
                          icon: <FolderOpen size={15} />,
                          onSelect: () => onOpenPath(contextMenu.file.path),
                        },
                      ]
                    : contextMenu.file.kind === "file"
                      ? [
                          {
                            id: "download",
                            label: t("sessions.download"),
                            icon: <Download size={15} />,
                            disabled: transferRunning,
                            onSelect: () => onDownload(contextMenu.file),
                          },
                        ]
                      : []),
                  {
                    id: "rename",
                    label: t("sessions.renameRemoteEntry"),
                    icon: <Pencil size={15} />,
                    disabled: operationBlocked,
                    onSelect: () =>
                      setFileOperation({
                        kind: "rename",
                        file: contextMenu.file,
                        value: contextMenu.file.name,
                        error: null,
                      }),
                  },
                  {
                    id: "delete",
                    label: t("sessions.deleteRemoteEntry"),
                    icon: <Trash2 size={15} />,
                    danger: true,
                    disabled: operationBlocked,
                    onSelect: () =>
                      setFileOperation({
                        kind: "delete",
                        file: contextMenu.file,
                        error: null,
                      }),
                  },
                  {
                    id: "copy",
                    label: t("sessions.contextCopyPath"),
                    icon: <Clipboard size={15} />,
                    onSelect: () => void copyPath(contextMenu.file.path),
                  },
                  {
                    id: "refresh",
                    label: t("sessions.refresh"),
                    icon: <RefreshCw size={15} />,
                    disabled: !sftpAvailable || loading,
                    onSelect: onRefresh,
                  },
                ]
          }
          onClose={() => setContextMenu(null)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}

      {fileOperation ? (
        <div className="dialog-backdrop terminal-dialog-backdrop">
          <section
            aria-modal="true"
            className="dialog file-operation-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !operationPending) {
                event.preventDefault();
                setFileOperation(null);
              }
            }}
            role="dialog"
          >
            <header className="dialog-header">
              <h2>{operationTitle}</h2>
            </header>
            <div className="file-operation-body">
              {fileOperation.kind === "delete" ? (
                <>
                  <p>
                    {t(
                      fileOperation.file.kind === "folder"
                        ? "sessions.confirmDeleteRemoteDirectory"
                        : "sessions.confirmDeleteRemoteEntry",
                      { name: fileOperation.file.name },
                    )}
                  </p>
                  <code>{fileOperation.file.path}</code>
                </>
              ) : (
                <label>
                  <span>
                    {fileOperation.kind === "create"
                      ? t("sessions.directoryName")
                      : t("sessions.newName")}
                  </span>
                  <TextInput
                    autoFocus
                    disabled={operationPending}
                    onChange={(event) => updateOperationValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void submitFileOperation();
                      }
                    }}
                    value={fileOperation.value}
                  />
                </label>
              )}
            </div>
            {fileOperation.error ? <div className="form-error">{fileOperation.error}</div> : null}
            <footer className="dialog-actions">
              <Button
                autoFocus={fileOperation.kind === "delete"}
                disabled={operationPending}
                onClick={() => setFileOperation(null)}
                variant="ghost"
              >
                {t("sessions.cancel")}
              </Button>
              <Button
                disabled={operationPending}
                onClick={() => void submitFileOperation()}
                variant={fileOperation.kind === "delete" ? "danger" : "primary"}
              >
                {fileOperation.kind === "delete"
                  ? t("sessions.deleteRemoteEntry")
                  : t("sessions.save")}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}

      {transfer ? (
        <section className={`transfer-bar transfer-${transfer.state}`}>
          <span>
            {transfer.direction === "upload" ? <Upload size={15} /> : <Download size={15} />}
            <strong>
              {transfer.fileName}
              {transfer.batchTotal && transfer.batchTotal > 1
                ? ` (${transfer.batchIndex}/${transfer.batchTotal})`
                : ""}
            </strong>
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

function isRemoteMoveCandidate(file: FileEntry) {
  return file.kind === "file" || file.kind === "folder";
}

function canMoveRemoteEntry(source: FileEntry, targetDirectory: string) {
  if (remoteParentPath(source.path) === targetDirectory) {
    return false;
  }
  return !(
    source.kind === "folder" &&
    (targetDirectory === source.path || targetDirectory.startsWith(`${source.path}/`))
  );
}

function remoteParentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function findRemoteDropTarget(
  clientX: number,
  clientY: number,
  source: FileEntry,
  panel: HTMLElement | null,
) {
  const target = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-remote-drop-path]");
  if (!target || !panel?.contains(target)) {
    return null;
  }
  const targetDirectory = target.dataset.remoteDropPath;
  return targetDirectory && canMoveRemoteEntry(source, targetDirectory)
    ? targetDirectory
    : null;
}

function fileRowClassName(
  file: FileEntry,
  selectedPath: string | undefined,
  remoteDrag: RemoteEntryDrag | null,
  moveStatus: RemoteMoveStatus | null,
  moveEnabled: boolean,
) {
  const movingTarget =
    (remoteDrag?.targetDirectory === file.path ||
      (moveStatus?.kind === "moving" && moveStatus.targetDirectory === file.path)) &&
    "file-row-drop-target";
  const successfulTarget =
    moveStatus?.kind === "success" && moveStatus.targetDirectory === file.path
      ? "file-row-move-success"
      : "";
  return [
    "file-row",
    moveEnabled && isRemoteMoveCandidate(file) ? "file-row-movable" : "",
    selectedPath === file.path ? "file-row-active" : "",
    remoteDrag?.source.path === file.path ? "file-row-dragging" : "",
    movingTarget,
    successfulTarget,
  ]
    .filter(Boolean)
    .join(" ");
}

function breadcrumbTargetClassName(
  path: string,
  remoteDrag: RemoteEntryDrag | null,
  moveStatus: RemoteMoveStatus | null,
) {
  if (moveStatus?.kind === "success" && moveStatus.targetDirectory === path) {
    return "breadcrumb-move-success";
  }
  if (
    remoteDrag?.targetDirectory === path ||
    (moveStatus?.kind === "moving" && moveStatus.targetDirectory === path)
  ) {
    return "breadcrumb-drop-target";
  }
  return undefined;
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
