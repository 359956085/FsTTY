import { TooltipButton } from "../../shared/ui/TooltipButton";
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
  type RefObject,
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
  isRemoteMoveCandidate,
  remoteParentPath,
} from "./fileUtils";
import {
  FILE_COLUMN_LIMITS,
} from "./workspacePreferences";
import { createRemoteEntryDragController } from "./remoteEntryDrag";
import { createFileOperationController, normalizeRemoteEntryName } from "./fileOperationController";
import {
  RESIZABLE_FILE_COLUMNS,
  useFileColumnResizing,
} from "./useFileColumnResizing";
import { installFileDragDropRuntime } from "./fileDragDropRuntime";
import type { RemoteEntryDeleteFailure } from "./sessionRemoteFiles";
import {
  createInlineRenameController,
  type InlineRenameState,
} from "./inlineRenameController";

interface FilesPaneProps {
  collapseButtonRef?: RefObject<HTMLButtonElement | null>;
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
  onDeleteEntries: (paths: string[]) => Promise<RemoteEntryDeleteFailure[]>;
  onDownload: (file: FileEntry) => void;
  onDownloadFiles: (files: FileEntry[]) => void;
  onMoveEntry: (sourcePath: string, targetDirectory: string) => Promise<void>;
  onOpenPath: (path: string) => void;
  onRefresh: () => void;
  onRenameEntry: (path: string, newName: string) => Promise<void>;
  onUpload: () => void;
  onUploadFiles: (localPaths: string[]) => void;
}

type FileContextMenu =
  | { kind: "directory"; x: number; y: number }
  | { kind: "entry"; x: number; y: number; file: FileEntry; files: FileEntry[] };

type FileOperationDialog =
  | { kind: "create"; value: string; error: string | null }
  | { kind: "rename"; file: FileEntry; value: string; error: string | null }
  | { kind: "delete"; files: FileEntry[]; error: string | null };

interface RemoteEntryDrag {
  source: FileEntry;
  targetDirectory: string | null;
}

interface FilePointerIntent {
  path: string;
  startedOnName: boolean;
}

type RemoteMoveStatus =
  | { kind: "moving" | "success"; sourceName: string; targetDirectory: string }
  | { kind: "error"; message: string };

export function FilesPane({
  collapseButtonRef,
  currentPath,
  files,
  loading,
  onCancelTransfer,
  onDismissTransfer,
  onCollapse,
  onCreateDirectory,
  onDeleteEntry,
  onDeleteEntries,
  onDownload,
  onDownloadFiles,
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
  const { adjustFileColumn, beginFileColumnResize, fileColumns, tableRef } =
    useFileColumnResizing();
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [fileOperation, setFileOperation] = useState<FileOperationDialog | null>(null);
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement>(null);
  const inlineRenameControllerRef = useRef<ReturnType<
    typeof createInlineRenameController
  > | null>(null);
  const operationControllerRef = useRef<ReturnType<
    typeof createFileOperationController
  > | null>(null);
  const filePointerIntentRef = useRef<FilePointerIntent | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [dragUploadActive, setDragUploadActive] = useState(false);
  const [remoteDrag, setRemoteDrag] = useState<RemoteEntryDrag | null>(null);
  const remoteDragControllerRef = useRef<ReturnType<
    typeof createRemoteEntryDragController
  > | null>(null);
  const suppressRemoteClickRef = useRef(false);
  const moveSuccessTimerRef = useRef<number | null>(null);
  const copyErrorTimerRef = useRef<number | null>(null);
  const copyRequestIdRef = useRef(0);
  const [copyError, setCopyError] = useState(false);
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
    operationControllerRef.current?.cancel("move");
    if (moveSuccessTimerRef.current !== null) {
      window.clearTimeout(moveSuccessTimerRef.current);
      moveSuccessTimerRef.current = null;
    }
    setMoveStatus(null);
  }, []);

  const cancelInlineRename = useCallback(() => {
    filePointerIntentRef.current = null;
    inlineRenameControllerRef.current?.cancel();
  }, []);

  const finishRemoteDrag = useCallback(() => {
    remoteDragControllerRef.current?.cancel();
    setDragUploadActive(false);
  }, []);

  useEffect(() => {
    if (operationBlocked) {
      inlineRenameControllerRef.current?.resetClick();
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
    inlineRenameControllerRef.current?.reconcile(files, loading);
  }, [files, loading]);

  useLayoutEffect(() => {
    if (!inlineRename?.file.path) {
      return;
    }
    const input = inlineRenameInputRef.current;
    input?.focus();
    input?.select();
  }, [inlineRename?.file.path]);

  useEffect(() => {
    // StrictMode 会重放 Effect；每次安装独占控制器，避免复用已销毁实例。
    const operationController = createFileOperationController();
    const remoteDragController = createRemoteEntryDragController({
      onChange: setRemoteDrag,
    });
    const inlineRenameController = createInlineRenameController({
      onChange: setInlineRename,
      onFocusRequested: () => {
        window.requestAnimationFrame(() => inlineRenameInputRef.current?.focus());
      },
      onPendingChange: setOperationPending,
    });
    operationControllerRef.current = operationController;
    remoteDragControllerRef.current = remoteDragController;
    inlineRenameControllerRef.current = inlineRenameController;
    const dragDropRuntime = installFileDragDropRuntime({
      getDragUploadState: () => dragUploadRef.current,
      getPanel: () => panelRef.current,
      onActiveChange: setDragUploadActive,
      onWindowBlur: () => {
        inlineRenameControllerRef.current?.resetClick();
        filePointerIntentRef.current = null;
        finishRemoteDrag();
      },
    });

    return () => {
      dragDropRuntime.dispose();
      remoteDragController.dispose();
      if (remoteDragControllerRef.current === remoteDragController) {
        remoteDragControllerRef.current = null;
      }
      suppressRemoteClickRef.current = false;
      inlineRenameController.resetClick();
      filePointerIntentRef.current = null;
      inlineRenameController.dispose();
      if (inlineRenameControllerRef.current === inlineRenameController) {
        inlineRenameControllerRef.current = null;
      }
      operationController.dispose();
      if (operationControllerRef.current === operationController) {
        operationControllerRef.current = null;
      }
      if (moveSuccessTimerRef.current !== null) {
        window.clearTimeout(moveSuccessTimerRef.current);
        moveSuccessTimerRef.current = null;
      }
      if (copyErrorTimerRef.current !== null) {
        window.clearTimeout(copyErrorTimerRef.current);
        copyErrorTimerRef.current = null;
      }
      copyRequestIdRef.current += 1;
    };
  }, [finishRemoteDrag]);

  useEffect(() => {
    selectionAnchorRef.current = null;
    setSelectedPaths(new Set());
    setContextMenu(null);
  }, [currentPath]);

  useEffect(() => {
    if (loading) return;
    setSelectedPaths((current) => {
      const remaining = files.filter((file) => current.has(file.path));
      const next = new Set(remaining.map((file) => file.path));
      if (next.size === 0 && files[0]) next.add(files[0].path);
      if (!files.some((file) => file.path === selectionAnchorRef.current)) {
        selectionAnchorRef.current = remaining[0]?.path ?? files[0]?.path ?? null;
      }
      return next;
    });
  }, [files, loading, currentPath]);

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

  const selectedFiles = useMemo(
    () => files.filter((file) => selectedPaths.has(file.path)),
    [files, selectedPaths],
  );
  const selected = selectedFiles.length === 1 ? selectedFiles[0] : null;
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
    const requestId = ++copyRequestIdRef.current;
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      if (requestId !== copyRequestIdRef.current) return;
      setCopyError(true);
      if (copyErrorTimerRef.current !== null) {
        window.clearTimeout(copyErrorTimerRef.current);
      }
      copyErrorTimerRef.current = window.setTimeout(() => {
        copyErrorTimerRef.current = null;
        setCopyError(false);
      }, 3000);
    }
  }

  function beginInlineRename(file: FileEntry) {
    if (operationBlocked) {
      return;
    }
    clearMoveFeedback();
    inlineRenameControllerRef.current?.resetClick();
    filePointerIntentRef.current = null;
    setContextMenu(null);
    selectFile(file);
    inlineRenameControllerRef.current?.begin(file);
  }

  function selectFile(
    file: FileEntry,
    modifiers?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) {
    const additive = modifiers?.ctrlKey || modifiers?.metaKey;
    const anchorIndex = files.findIndex((entry) => entry.path === selectionAnchorRef.current);
    const targetIndex = files.findIndex((entry) => entry.path === file.path);
    if (modifiers?.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      const range = files.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
      setSelectedPaths((current) => new Set([
        ...(additive ? current : []),
        ...range.map((entry) => entry.path),
      ]));
    } else {
      selectionAnchorRef.current = file.path;
      setSelectedPaths((current) => {
        if (!additive) return new Set([file.path]);
        const next = new Set(current);
        if (next.has(file.path)) next.delete(file.path);
        else next.add(file.path);
        return next;
      });
    }
  }

  function clearSelection() {
    setSelectedPaths(new Set());
    selectionAnchorRef.current = null;
    inlineRenameControllerRef.current?.resetClick();
    filePointerIntentRef.current = null;
    setContextMenu(null);
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

    if (event.ctrlKey || event.metaKey || event.shiftKey || selectedFiles.length > 1) {
      inlineRenameControllerRef.current?.resetClick();
      selectFile(file, event);
      return;
    }

    const startedOnName =
      pointerIntent?.path === file.path &&
      pointerIntent.startedOnName &&
      isRemoteMoveCandidate(file);
    if (!startedOnName) {
      inlineRenameControllerRef.current?.resetClick();
      selectFile(file, event);
      return;
    }

    const currentClick = { path: file.path, timeMs: event.timeStamp };
    const shouldRename =
      inlineRenameControllerRef.current?.registerNameClick(
        file,
        selected?.path ?? null,
        currentClick,
        event.detail,
        operationBlocked,
      ) ?? false;
    selectFile(file, event);
    if (shouldRename) {
      beginInlineRename(file);
    }
  }

  function updateInlineRenameValue(value: string) {
    inlineRenameControllerRef.current?.update(value);
  }

  async function submitInlineRename() {
    await inlineRenameControllerRef.current?.submit({
      formatError: (error) => resolveApiError(error, t("errors.unknown")),
      rename: onRenameEntry,
      requiredError: t("sessions.remoteNameRequired"),
    });
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
      event.ctrlKey || event.metaKey || event.shiftKey ||
      (selectedFiles.length > 1 && selectedPaths.has(file.path)) ||
      operationBlocked ||
      !isRemoteMoveCandidate(file)
    ) {
      return;
    }
    selectFile(file);
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
      inlineRenameControllerRef.current?.resetClick();
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
    const operationController = operationControllerRef.current;
    if (!operationController) {
      return;
    }

    setMoveStatus({
      kind: "moving",
      sourceName: source.name,
      targetDirectory,
    });
    void operationController.run(
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
    const operationController = operationControllerRef.current;
    if (!fileOperation || !operationController || operationController.isPending("dialog")) {
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
    await operationController.run(
      "dialog",
      async () => {
        if (fileOperation.kind === "create") {
          return onCreateDirectory(normalizedName!);
        }
        if (fileOperation.kind === "rename") {
          return onRenameEntry(fileOperation.file.path, normalizedName!);
        }
        if (fileOperation.files.length > 1) {
          const filesByPath = new Map(fileOperation.files.map((file) => [file.path, file]));
          return (await onDeleteEntries(fileOperation.files.map((file) => file.path)))
            .map(({ path, message }) => ({ file: filesByPath.get(path)!, error: message }));
        }
        const failures: { file: FileEntry; error: unknown }[] = [];
        for (const file of fileOperation.files) {
          try {
            await onDeleteEntry(file.path);
          } catch (error) {
            failures.push({ file, error });
          }
        }
        return failures;
      },
      {
        onPendingChange: setOperationPending,
        onSuccess: (failures) => {
          if (!failures?.length) {
            setFileOperation(null);
            return;
          }
          setFileOperation({
            kind: "delete",
            files: failures.map(({ file }) => file),
            error: t("sessions.deleteRemoteEntriesFailed", {
              count: failures.length,
              message: resolveApiError(failures[0].error, t("errors.unknown")),
            }),
          });
        },
        onError: (error) => {
          const message = resolveApiError(error, t("errors.unknown"));
          setFileOperation((current) =>
            current ? { ...current, error: message } : current,
          );
        },
      },
    );
  }

  return (
    <section
      className={remoteDrag ? "files-panel remote-entry-dragging" : "files-panel"}
      onContextMenu={(event) => event.preventDefault()}
      ref={panelRef}
    >
      <header className="panel-title">
        <h2>{t("sessions.files")}</h2>
        {selectedFiles.length > 1 ? (
          <span className="file-selection-count" role="status">
            {t("sessions.selectedFiles", { count: selectedFiles.length })}
          </span>
        ) : null}
        <span className="panel-title-actions">
          <TooltipButton
            label={t("sessions.upload")}
            className="icon-button"
            disabled={operationBlocked}
            onClick={onUpload}
            type="button"
          >
            <Upload size={17} />
          </TooltipButton>
          <TooltipButton
            aria-expanded
            buttonRef={collapseButtonRef}
            label={t("nav.collapseFiles")}
            className="icon-button"
            onClick={onCollapse}
            type="button"
          >
            <ChevronRight size={18} />
          </TooltipButton>
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

      {copyError ? (
        <div className="file-move-notice file-move-error" role="alert">
          {t("sessions.clipboardWriteFailed")}
        </div>
      ) : inlineRename?.error ? (
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
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ kind: "directory", x: event.clientX, y: event.clientY });
        }}
        ref={tableRef}
      >
        <div className="file-row file-head">
          {RESIZABLE_FILE_COLUMNS.map((column) => {
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
              aria-pressed={renaming ? undefined : selectedPaths.has(file.path)}
              className={fileRowClassName(
                file,
                selectedPaths.has(file.path) ? file.path : undefined,
                remoteDrag,
                moveStatus,
                !operationBlocked && selectedFiles.length <= 1,
              )}
              data-remote-drop-path={file.kind === "folder" ? file.path : undefined}
              key={file.path}
              onClick={(event) => handleFileRowClick(file, event)}
              onDoubleClick={(event) => {
                inlineRenameControllerRef.current?.resetClick();
                filePointerIntentRef.current = null;
                if (suppressRemoteClickRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (file.kind === "folder" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                  onOpenPath(file.path);
                }
              }}
              onKeyDown={(event) => {
                if (
                  !renaming &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  inlineRenameControllerRef.current?.resetClick();
                  filePointerIntentRef.current = null;
                  selectFile(file, event);
                }
              }}
              onLostPointerCapture={finishRemoteDrag}
              onPointerCancel={() => {
                inlineRenameControllerRef.current?.resetClick();
                filePointerIntentRef.current = null;
                finishRemoteDrag();
              }}
              onPointerDown={(event) => beginRemotePointerDrag(file, event)}
              onPointerMove={updateRemotePointerDrag}
              onPointerUp={finishRemotePointerDrag}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                inlineRenameControllerRef.current?.resetClick();
                filePointerIntentRef.current = null;
                const menuFiles = selectedPaths.has(file.path) ? selectedFiles : [file];
                if (!selectedPaths.has(file.path)) selectFile(file);
                setContextMenu({
                  kind: "entry",
                  x: event.clientX,
                  y: event.clientY,
                  file,
                  files: menuFiles,
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
              : contextMenu.files.length > 1
                ? [
                    {
                      id: "download",
                      label: t("sessions.download"),
                      icon: <Download size={15} />,
                      disabled: operationBlocked || contextMenu.files.some((file) => file.kind !== "file"),
                      onSelect: () => onDownloadFiles(contextMenu.files),
                    },
                    {
                      id: "delete",
                      label: t("sessions.deleteRemoteEntry"),
                      icon: <Trash2 size={15} />,
                      danger: true,
                      disabled: operationBlocked,
                      onSelect: () => setFileOperation({ kind: "delete", files: contextMenu.files, error: null }),
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
                            disabled: operationBlocked,
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
                        files: [contextMenu.file],
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
                      fileOperation.files.length > 1
                        ? "sessions.confirmDeleteRemoteEntries"
                        : fileOperation.files[0].kind === "folder"
                        ? "sessions.confirmDeleteRemoteDirectory"
                        : "sessions.confirmDeleteRemoteEntry",
                      { name: fileOperation.files[0].name, count: fileOperation.files.length },
                    )}
                  </p>
                  <div className="file-operation-entries">
                    {fileOperation.files.map((file) => <code key={file.path}>{file.path}</code>)}
                  </div>
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
              {transfer.direction === "download" && transfer.batchTotal && transfer.batchTotal > 1
                ? t("sessions.downloadBatchProgress", {
                    completed: (transfer.downloaded ?? 0) + (transfer.skipped ?? 0) + (transfer.failed ?? 0),
                    total: transfer.batchTotal,
                  })
                : transfer.fileName}
              {transfer.direction === "upload" && transfer.batchTotal && transfer.batchTotal > 1
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
          {transfer.direction === "download" && transfer.batchTotal && transfer.batchTotal > 1 ? (
            <small className="transfer-queue-status" role="status">
              {transferRunning
                ? t("sessions.downloadQueueStatus", { active: transfer.activeCount ?? 0, queued: transfer.queuedCount ?? 0 })
                : t("sessions.downloadBatchSummary", { downloaded: transfer.downloaded ?? 0, skipped: transfer.skipped ?? 0, failed: transfer.failed ?? 0 })}
            </small>
          ) : null}
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
