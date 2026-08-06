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
  Save,
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
  type MouseEvent as ReactMouseEvent,
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
  buildBreadcrumbs,
  breadcrumbTargetClassName,
  canMoveRemoteEntry,
  createModifiedTimeFormatter,
  formatModifiedTime,
  formatSize,
  formatTransferSpeed,
  fileRowClassName,
  isSlowRenameClick,
  isRemoteMoveCandidate,
  remoteParentPath,
  type FileNameClick,
} from "./fileUtils";
import {
  FILE_COLUMN_LIMITS,
  readWorkspacePreferences,
  updateWorkspacePreferences,
  type FileColumnPreferences,
} from "./workspacePreferences";
import { createRemoteEntryDragController } from "./remoteEntryDrag";
import {
  createFileOperationController,
  normalizeRemoteEntryName,
} from "./fileOperationController";

type ResizableFileColumn = "name" | "size" | "modified";
const RESIZABLE_FILE_COLUMNS: readonly ResizableFileColumn[] = [
  "name",
  "size",
  "modified",
];

const FILE_COLUMN_KEYBOARD_STEP = 8;

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

interface InlineRenameState {
  error: string | null;
  file: FileEntry;
  value: string;
}

interface FilePointerIntent {
  path: string;
  startedOnName: boolean;
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
  const { t, i18n } = useTranslation();
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
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);
  const inlineRenameRef = useRef<InlineRenameState | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement>(null);
  const operationControllerRef = useRef(createFileOperationController());
  const fileNameClickRef = useRef<FileNameClick | null>(null);
  const filePointerIntentRef = useRef<FilePointerIntent | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [dragUploadActive, setDragUploadActive] = useState(false);
  const [remoteDrag, setRemoteDrag] = useState<RemoteEntryDrag | null>(null);
  const remoteDragControllerRef = useRef<ReturnType<
    typeof createRemoteEntryDragController
  > | null>(null);
  remoteDragControllerRef.current ??= createRemoteEntryDragController({
    onChange: setRemoteDrag,
  });
  const suppressRemoteClickRef = useRef(false);
  const moveSuccessTimerRef = useRef<number | null>(null);
  const [moveStatus, setMoveStatus] = useState<RemoteMoveStatus | null>(null);
  const [moveRequestPending, setMoveRequestPending] = useState(false);
  const [speedDisplayTimeMs, setSpeedDisplayTimeMs] = useState(() => performance.now());
  const transferRunning = transfer?.state === "running";
  const operationBlocked =
    !sftpAvailable ||
    loading ||
    transferRunning ||
    operationPending ||
    moveRequestPending ||
    fileOperation !== null ||
    inlineRename !== null;
  const dragUploadRef = useRef({ enabled: !operationBlocked, onUploadFiles });
  dragUploadRef.current = { enabled: !operationBlocked, onUploadFiles };

  const clearMoveFeedback = useCallback(() => {
    operationControllerRef.current.cancel("move");
    if (moveSuccessTimerRef.current !== null) {
      window.clearTimeout(moveSuccessTimerRef.current);
      moveSuccessTimerRef.current = null;
    }
    setMoveStatus(null);
  }, []);

  const cancelInlineRename = useCallback(() => {
    fileNameClickRef.current = null;
    filePointerIntentRef.current = null;
    operationControllerRef.current.cancel("inlineRename");
    inlineRenameRef.current = null;
    setInlineRename(null);
  }, []);

  const finishRemoteDrag = useCallback(() => {
    remoteDragControllerRef.current?.cancel();
    setDragUploadActive(false);
  }, []);

  useLayoutEffect(() => {
    fileColumnsRef.current = fileColumns;
    for (const column of RESIZABLE_FILE_COLUMNS) {
      applyFileColumnWidth(tableRef.current, column, fileColumns[column]);
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
      fileNameClickRef.current = null;
      filePointerIntentRef.current = null;
      finishRemoteDrag();
    }
  }, [finishRemoteDrag, operationBlocked]);

  useEffect(() => {
    finishRemoteDrag();
    clearMoveFeedback();
    cancelInlineRename();
  }, [
    cancelInlineRename,
    clearMoveFeedback,
    currentPath,
    finishRemoteDrag,
    sftpAvailable,
  ]);

  useEffect(() => {
    const current = inlineRenameRef.current;
    if (
      current &&
      !loading &&
      !files.some((file) => file.path === current.file.path)
    ) {
      cancelInlineRename();
    }
  }, [cancelInlineRename, files, loading]);

  useLayoutEffect(() => {
    if (!inlineRenameRef.current) {
      return;
    }
    const input = inlineRenameInputRef.current;
    input?.focus();
    input?.select();
  }, [inlineRename?.file.path]);

  useEffect(() => {
    let disposed = false;
    let removeDragDropListener: () => void = () => undefined;
    let removeScaleListener: () => void = () => undefined;
    const operationController = operationControllerRef.current;
    const handleWindowBlur = () => {
      fileNameClickRef.current = null;
      filePointerIntentRef.current = null;
      finishRemoteDrag();
    };
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
      remoteDragControllerRef.current?.dispose();
      suppressRemoteClickRef.current = false;
      fileNameClickRef.current = null;
      filePointerIntentRef.current = null;
      inlineRenameRef.current = null;
      operationController.dispose();
      if (moveSuccessTimerRef.current !== null) {
        window.clearTimeout(moveSuccessTimerRef.current);
        moveSuccessTimerRef.current = null;
      }
    };
  }, [finishRemoteDrag]);

  useEffect(() => {
    setSelectedPath((current) => {
      if (current && files.some((file) => file.path === current)) {
        return current;
      }
      return files[0]?.path ?? null;
    });
  }, [files]);

  useEffect(() => {
    if (!transferRunning || !transfer) {
      return;
    }
    const remainingMs = Math.max(
      transfer.speedUpdatedAtMs + 1500 - performance.now(),
      0,
    );
    const timeout = window.setTimeout(
      () => setSpeedDisplayTimeMs(performance.now()),
      remainingMs,
    );
    return () => window.clearTimeout(timeout);
  }, [transfer, transferRunning]);

  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);
  const modifiedTimeFormatter = useMemo(
    () => createModifiedTimeFormatter(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage],
  );
  const parentPath = remoteParentPath(currentPath);
  const progressPercent = transfer?.totalBytes
    ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100))
    : 0;
  const displayedSpeed =
    transferRunning &&
    transfer &&
    speedDisplayTimeMs - transfer.speedUpdatedAtMs < 1500
      ? transfer.speedBytesPerSecond
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

  function beginInlineRename(file: FileEntry) {
    if (operationBlocked || inlineRenameRef.current) {
      return;
    }
    clearMoveFeedback();
    fileNameClickRef.current = null;
    filePointerIntentRef.current = null;
    setContextMenu(null);
    setSelectedPath(file.path);
    const next = { file, value: file.name, error: null };
    inlineRenameRef.current = next;
    setInlineRename(next);
  }

  function handleFileRowClick(
    file: FileEntry,
    event: ReactMouseEvent<HTMLDivElement>,
  ) {
    const pointerIntent = filePointerIntentRef.current;
    filePointerIntentRef.current = null;
    if (suppressRemoteClickRef.current) {
      event.preventDefault();
      return;
    }

    const startedOnName =
      pointerIntent?.path === file.path &&
      pointerIntent.startedOnName &&
      isRemoteMoveCandidate(file);
    if (!startedOnName) {
      fileNameClickRef.current = null;
      setSelectedPath(file.path);
      return;
    }

    const currentClick = { path: file.path, timeMs: event.timeStamp };
    const shouldRename =
      !operationBlocked &&
      selectedPath === file.path &&
      isSlowRenameClick(fileNameClickRef.current, currentClick, event.detail);
    fileNameClickRef.current = shouldRename ? null : currentClick;
    setSelectedPath(file.path);
    if (shouldRename) {
      beginInlineRename(file);
    }
  }

  function updateInlineRenameValue(value: string) {
    const current = inlineRenameRef.current;
    if (!current) {
      return;
    }
    const next = { ...current, value, error: null };
    inlineRenameRef.current = next;
    setInlineRename(next);
  }

  async function submitInlineRename() {
    const current = inlineRenameRef.current;
    if (!current || operationControllerRef.current.isPending("inlineRename")) {
      return;
    }

    const newName = normalizeRemoteEntryName(current.value);
    if (!newName) {
      const next = { ...current, error: t("sessions.remoteNameRequired") };
      inlineRenameRef.current = next;
      setInlineRename(next);
      window.requestAnimationFrame(() => inlineRenameInputRef.current?.focus());
      return;
    }
    if (newName === current.file.name) {
      cancelInlineRename();
      return;
    }

    const pending = { ...current, value: newName, error: null };
    inlineRenameRef.current = pending;
    setInlineRename(pending);
    await operationControllerRef.current.run(
      "inlineRename",
      () => onRenameEntry(current.file.path, newName),
      {
        onPendingChange: setOperationPending,
        onSuccess: () => {
        inlineRenameRef.current = null;
        setInlineRename(null);
        },
        onError: (error) => {
          const failed = {
            ...pending,
            error: resolveApiError(error, t("errors.unknown")),
          };
          inlineRenameRef.current = failed;
          setInlineRename(failed);
          window.requestAnimationFrame(() => inlineRenameInputRef.current?.focus());
        },
      },
    );
  }

  function beginRemotePointerDrag(
    file: FileEntry,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button === 0 && event.isPrimary) {
      const target = event.target;
      filePointerIntentRef.current = {
        path: file.path,
        startedOnName:
          target instanceof Element && target.closest(".file-name-cell") !== null,
      };
    } else {
      filePointerIntentRef.current = null;
    }

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
    remoteDragControllerRef.current?.begin({
      captureTarget: event.currentTarget,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      source: file,
    });
  }

  function updateRemotePointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const targetDirectory = findRemoteDropTarget(
      event.clientX,
      event.clientY,
      remoteDragControllerRef.current?.source() ?? null,
      panelRef.current,
    );
    const result = remoteDragControllerRef.current?.move({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      targetDirectory,
    });
    if (!result?.active) {
      return;
    }
    if (result.started) {
      fileNameClickRef.current = null;
      filePointerIntentRef.current = null;
      clearMoveFeedback();
    }
    event.preventDefault();
  }

  function finishRemotePointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const result = remoteDragControllerRef.current?.finish(event.pointerId);
    setDragUploadActive(false);
    if (!result?.suppressClick) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressRemoteClickRef.current = true;
    window.setTimeout(() => {
      suppressRemoteClickRef.current = false;
    }, 0);
    if (!result.move) {
      return;
    }
    const { source, targetDirectory } = result.move;

    setMoveStatus({
      kind: "moving",
      sourceName: source.name,
      targetDirectory,
    });
    void operationControllerRef.current.run(
      "move",
      () => onMoveEntry(source.path, targetDirectory),
      {
        onPendingChange: setMoveRequestPending,
        onSuccess: () => {
        setMoveStatus({
          kind: "success",
          sourceName: source.name,
          targetDirectory,
        });
        moveSuccessTimerRef.current = window.setTimeout(() => {
          setMoveStatus(null);
          moveSuccessTimerRef.current = null;
        }, 2500);
        },
        onError: (error) => {
          setMoveStatus({
            kind: "error",
            message: resolveApiError(error, t("sessions.moveRemoteEntryFailed")),
          });
        },
      },
    );
  }

  function updateOperationValue(value: string) {
    setFileOperation((current) =>
      current && current.kind !== "delete" ? { ...current, value, error: null } : current,
    );
  }

  async function submitFileOperation() {
    if (!fileOperation || operationControllerRef.current.isPending("dialog")) {
      return;
    }
    const normalizedName =
      fileOperation.kind === "delete"
        ? null
        : normalizeRemoteEntryName(fileOperation.value);
    if (fileOperation.kind !== "delete" && !normalizedName) {
      setFileOperation({ ...fileOperation, error: t("sessions.remoteNameRequired") });
      return;
    }

    setFileOperation({ ...fileOperation, error: null });
    await operationControllerRef.current.run(
      "dialog",
      () => {
        if (fileOperation.kind === "create") {
          return onCreateDirectory(normalizedName!);
        }
        if (fileOperation.kind === "rename") {
          return onRenameEntry(fileOperation.file.path, normalizedName!);
        }
        return onDeleteEntry(fileOperation.file.path);
      },
      {
        onPendingChange: setOperationPending,
        onSuccess: () => setFileOperation(null),
        onError: (error) => {
          const message = resolveApiError(error, t("errors.unknown"));
          setFileOperation((current) =>
            current ? { ...current, error: message } : current,
          );
        },
      },
    );
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

      {inlineRename?.error ? (
        <div className="file-move-notice file-move-error" role="alert">
          <span>{inlineRename.error}</span>
        </div>
      ) : moveStatus?.kind === "moving" ? (
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
          const modified = formatModifiedTime(file.modifiedAt, modifiedTimeFormatter);
          const permissions = file.permissions.split(" ")[0];
          const renaming = inlineRename?.file.path === file.path;
          return (
            <div
              aria-label={file.name}
              aria-pressed={renaming ? undefined : selected?.path === file.path}
              className={fileRowClassName(
                file,
                selected?.path,
                remoteDrag,
                moveStatus,
                !operationBlocked,
              )}
              data-remote-drop-path={file.kind === "folder" ? file.path : undefined}
              key={file.path}
              onClick={(event) => handleFileRowClick(file, event)}
              onDoubleClick={(event) => {
                fileNameClickRef.current = null;
                filePointerIntentRef.current = null;
                if (suppressRemoteClickRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (file.kind === "folder") {
                  onOpenPath(file.path);
                }
              }}
              onKeyDown={(event) => {
                if (
                  !renaming &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  fileNameClickRef.current = null;
                  filePointerIntentRef.current = null;
                  setSelectedPath(file.path);
                }
              }}
              onLostPointerCapture={finishRemoteDrag}
              onPointerCancel={() => {
                fileNameClickRef.current = null;
                filePointerIntentRef.current = null;
                finishRemoteDrag();
              }}
              onPointerDown={(event) => beginRemotePointerDrag(file, event)}
              onPointerMove={updateRemotePointerDrag}
              onPointerUp={finishRemotePointerDrag}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                fileNameClickRef.current = null;
                filePointerIntentRef.current = null;
                setSelectedPath(file.path);
                setContextMenu({
                  kind: "entry",
                  x: event.clientX,
                  y: event.clientY,
                  file,
                });
              }}
              role={renaming ? undefined : "button"}
              tabIndex={renaming ? -1 : 0}
            >
              <span
                className="file-name-cell"
                title={file.name}
              >
                <Icon size={16} />
                {renaming && inlineRename ? (
                  <input
                    aria-label={t("sessions.renameRemoteEntry")}
                    className={
                      inlineRename.error
                        ? "file-inline-rename file-inline-rename-error"
                        : "file-inline-rename"
                    }
                    disabled={operationPending}
                    onBlur={() => void submitInlineRename()}
                    onChange={(event) => updateInlineRenameValue(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelInlineRename();
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        void submitInlineRename();
                      }
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    ref={inlineRenameInputRef}
                    value={inlineRename.value}
                  />
                ) : (
                  <span className="file-name-text">{file.name}</span>
                )}
              </span>
              <span title={size}>{size}</span>
              <span title={modified}>{modified}</span>
              <span title={permissions}>{permissions}</span>
            </div>
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
                    id: "copyCurrentFolderPath",
                    label: t("sessions.contextCopyCurrentFolderPath"),
                    icon: <Clipboard size={15} />,
                    onSelect: () => void copyPath(currentPath),
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
                icon={
                  fileOperation.kind === "create" ? (
                    <FolderPlus aria-hidden="true" size={16} />
                  ) : fileOperation.kind === "rename" ? (
                    <Save aria-hidden="true" size={16} />
                  ) : (
                    <Trash2 aria-hidden="true" size={16} />
                  )
                }
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
                : `${progressPercent}% · ${formatTransferSpeed(displayedSpeed)}`}
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

function findRemoteDropTarget(
  clientX: number,
  clientY: number,
  source: FileEntry | null,
  panel: HTMLElement | null,
) {
  const target = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-remote-drop-path]");
  if (!target || !panel?.contains(target)) {
    return null;
  }
  const targetDirectory = target.dataset.remoteDropPath;
  return source && targetDirectory && canMoveRemoteEntry(source, targetDirectory)
    ? targetDirectory
    : null;
}
