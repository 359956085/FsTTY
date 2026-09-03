import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import i18n from "../../shared/i18n";
import { hasControlCharacter } from "../../shared/validation/text";
import type {
  ConnectionState,
  DeviceStatus,
  FileEntry,
  SshConnection,
  TransferJobSummary,
} from "../../shared/api/types";
import { getInitialLightweightModeState, hasPreservedTerminal } from "../lightweight/lightweightMode";
import { DEFAULT_REMOTE_PATH } from "./constants";
import {
  DEVICE_POLL_INTERVAL_MS,
  type DeviceMetricSample,
} from "./deviceMetrics";
import {
  createSessionDevicePollingController,
  type SessionDevicePollingController,
} from "./sessionDevicePolling";
import {
  createSessionRemoteFilesController,
  type SessionRemoteFilesController,
} from "./sessionRemoteFiles";
import { createSessionRuntimeController } from "./sessionRuntimeController";
import { createTransferJobSubscription } from "./sessionTransferJob";

export interface TransferProgress {
  id: string;
  connectionId?: string;
  direction: "upload" | "download";
  fileName: string;
  batchIndex?: number;
  batchTotal?: number;
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  speedUpdatedAtMs: number;
  state: "running" | "completed" | "cancelled";
}

export interface SessionRuntime {
  connectionState: ConnectionState;
  connection: SshConnection | null;
  error: string | null;
  currentPath: string;
  files: FileEntry[];
  filesLoading: boolean;
  deviceLoading: boolean;
  deviceStatus: DeviceStatus | null;
  deviceHistory: DeviceMetricSample[];
  deviceWindowEndMs: number;
  transfer: TransferProgress | null;
}

interface UseSessionConnectionsOptions {
  errorFallback: string;
}

export function useSessionConnections({ errorFallback }: UseSessionConnectionsOptions) {
  const [runtimes, setRuntimes] = useState<Record<string, SessionRuntime>>({});
  const runtimesRef = useRef(runtimes);
  const errorFallbackRef = useRef(errorFallback);
  const runtimeControllerRef = useRef(createSessionRuntimeController());
  const remoteFilesControllerRef = useRef<SessionRemoteFilesController | null>(null);
  const devicePollingControllerRef = useRef<SessionDevicePollingController | null>(null);
  const attachedTransferJobsRef = useRef(new Set<string>());

  useEffect(() => {
    runtimesRef.current = runtimes;
  }, [runtimes]);
  errorFallbackRef.current = errorFallback;

  const updateRuntime = useCallback(
    (sessionId: string, update: (runtime: SessionRuntime) => SessionRuntime) => {
      setRuntimes((current) => {
        const existing = current[sessionId];
        const nextRuntime = update(existing ?? createRuntime());
        if (existing && nextRuntime === existing) {
          return current;
        }
        const next = {
          ...current,
          [sessionId]: nextRuntime,
        };
        runtimesRef.current = next;
        return next;
      });
    },
    [],
  );

  if (!remoteFilesControllerRef.current) {
    remoteFilesControllerRef.current = createSessionRemoteFilesController<SessionRuntime>({
      defaultPath: DEFAULT_REMOTE_PATH,
      getRuntime: (sessionId) => runtimesRef.current[sessionId],
      listFiles: (connectionId, path) => api.listRemoteFiles(connectionId, path),
      normalizePath: normalizeRemotePath,
      operationBusyError: () => i18n.t("sessions.fileOperationBusy"),
      operationUnavailableError: () => i18n.t("sessions.sftpOperationUnavailable"),
      resolveError: (error) => resolveApiError(error, errorFallbackRef.current),
      updateRuntime,
    });
  }
  if (!devicePollingControllerRef.current) {
    devicePollingControllerRef.current =
      createSessionDevicePollingController<SessionRuntime>({
        getDeviceMetricsSnapshot: (connectionId) => api.getDeviceMetricsSnapshot(connectionId),
        getRuntime: (sessionId) => runtimesRef.current[sessionId],
        intervalMs: DEVICE_POLL_INTERVAL_MS,
        updateRuntime,
      });
  }

  useEffect(() => {
    const runtimeController = runtimeControllerRef.current;
    const remoteFilesController = remoteFilesControllerRef.current;
    const devicePollingController = devicePollingControllerRef.current;
    runtimeController.activate();
    remoteFilesController?.activate();
    devicePollingController?.activate();
    return () => {
      runtimeController.dispose();
      remoteFilesController?.dispose();
      devicePollingController?.dispose();
    };
  }, []);

  const loadFiles = useCallback(
    (sessionId: string, connectionId: string, path: string) =>
      remoteFilesControllerRef.current!.loadFiles(sessionId, connectionId, path),
    [],
  );

  const startDevicePolling = useCallback(
    (sessionId: string, connectionId: string) => {
      devicePollingControllerRef.current!.start(sessionId, connectionId);
    },
    [],
  );

  const handleConnected = useCallback(
    (sessionId: string, connection: SshConnection) => {
      runtimeControllerRef.current.cancelUploadBatch(sessionId);
      // 登录提示符可能先于 connectSession 返回 OSC；控制器保证首次目录上报不丢失。
      const currentPath = remoteFilesControllerRef.current!.consumeInitialPath(
        sessionId,
        connection.homePath,
      );
      remoteFilesControllerRef.current!.cancelSession(sessionId);
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        connectionState: "connected",
        connection,
        error: null,
        currentPath,
        files: [],
        deviceStatus:
          runtime.connection?.connectionId === connection.connectionId ? runtime.deviceStatus : null,
        deviceHistory:
          runtime.connection?.connectionId === connection.connectionId ? runtime.deviceHistory : [],
        deviceWindowEndMs:
          runtime.connection?.connectionId === connection.connectionId ? runtime.deviceWindowEndMs : 0,
        transfer:
          runtime.transfer?.connectionId === connection.connectionId
            ? runtime.transfer
            : null,
      }));
      if (connection.sftpAvailable) {
        void loadFiles(sessionId, connection.connectionId, currentPath);
      }
      startDevicePolling(sessionId, connection.connectionId);
    },
    [loadFiles, startDevicePolling, updateRuntime],
  );

  const handleTerminalState = useCallback(
    (sessionId: string, state: ConnectionState, error: string | null = null) => {
      const replacingConnection = state === "connecting" && !hasPreservedTerminal(sessionId);
      const stopDevicePolling = replacingConnection || state === "disconnecting" ||
        state === "disconnected" || state === "error";
      if (state === "connecting" || state === "disconnected" || state === "error") {
        remoteFilesControllerRef.current!.cancelSession(sessionId);
        runtimeControllerRef.current.cancelUploadBatch(sessionId);
        if (replacingConnection) runtimeControllerRef.current.cancelTransfer(sessionId);
      }
      if (stopDevicePolling) {
        devicePollingControllerRef.current!.cancelSession(sessionId);
      }
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        connectionState: state,
        connection:
          state === "disconnected" || state === "error" ? null : runtime.connection,
        error,
        files:
          state === "disconnected" || state === "error" ? [] : runtime.files,
        filesLoading:
          state === "disconnected" || state === "error"
            ? false
            : runtime.filesLoading,
        currentPath:
          state === "disconnected" || state === "error"
            ? DEFAULT_REMOTE_PATH
            : runtime.currentPath,
        deviceLoading: stopDevicePolling ? false : runtime.deviceLoading,
        deviceStatus:
          state === "disconnected" || state === "error"
            ? null
            : runtime.deviceStatus,
        deviceHistory:
          state === "disconnected" || state === "error"
            ? []
            : runtime.deviceHistory,
        deviceWindowEndMs:
          state === "disconnected" || state === "error" ? 0 : runtime.deviceWindowEndMs,
        transfer:
          replacingConnection
            ? null
            : runtime.transfer,
      }));
    },
    [updateRuntime],
  );

  const openPath = useCallback(
    (sessionId: string, path: string) =>
      remoteFilesControllerRef.current!.openPath(sessionId, path),
    [],
  );

  const handleTerminalDirectory = useCallback(
    (sessionId: string, path: string) =>
      remoteFilesControllerRef.current!.handleTerminalDirectory(sessionId, path),
    [],
  );

  const refreshFiles = useCallback(
    (sessionId: string) => remoteFilesControllerRef.current!.refreshFiles(sessionId),
    [],
  );

  const runRemoteMutation = useCallback(
    async (
      sessionId: string,
      mutation: (connectionId: string, currentPath: string) => Promise<void>,
    ) => {
      await remoteFilesControllerRef.current!.runMutation(sessionId, mutation);
    },
    [],
  );

  const createRemoteDirectory = useCallback(
    (sessionId: string, name: string) =>
      runRemoteMutation(sessionId, (connectionId, currentPath) =>
        api.createRemoteDirectory(connectionId, currentPath, name),
      ),
    [runRemoteMutation],
  );

  const renameRemoteEntry = useCallback(
    (sessionId: string, path: string, newName: string) =>
      runRemoteMutation(sessionId, (connectionId) =>
        api.renameRemoteEntry(connectionId, path, newName),
      ),
    [runRemoteMutation],
  );

  const moveRemoteEntry = useCallback(
    (sessionId: string, sourcePath: string, targetDirectory: string) =>
      runRemoteMutation(sessionId, (connectionId) =>
        api.moveRemoteEntry(connectionId, sourcePath, targetDirectory),
      ),
    [runRemoteMutation],
  );

  const deleteRemoteEntry = useCallback(
    (sessionId: string, path: string) =>
      runRemoteMutation(sessionId, (connectionId) =>
        api.deleteRemoteEntry(connectionId, path),
      ),
    [runRemoteMutation],
  );

  const refreshSession = useCallback(
    (sessionId: string) => remoteFilesControllerRef.current!.refreshSession(sessionId),
    [],
  );

  const disconnect = useCallback(
    async (sessionId: string) => {
      const runtime = runtimesRef.current[sessionId];
      if (!runtime?.connection) {
        if (runtime?.connectionState === "connecting") {
          // 连接尚未返回 ID 时用会话 ID 取消后端全部进行中的连接尝试。
          await api.disconnectSession(sessionId).catch(() => undefined);
        }
        handleTerminalState(sessionId, "disconnected");
        return;
      }
      handleTerminalState(sessionId, "disconnecting");
      try {
        await api.disconnectSession(runtime.connection.connectionId);
        handleTerminalState(sessionId, "disconnected");
      } catch (error) {
        handleTerminalState(
          sessionId,
          "error",
          resolveApiError(error, errorFallback),
        );
      }
    },
    [errorFallback, handleTerminalState],
  );

  const removeRuntime = useCallback((sessionId: string) => {
    remoteFilesControllerRef.current!.removeSession(sessionId);
    devicePollingControllerRef.current!.removeSession(sessionId);
    runtimeControllerRef.current.removeSession(sessionId);
    setRuntimes((current) => {
      const next = { ...current };
      delete next[sessionId];
      runtimesRef.current = next;
      return next;
    });
  }, []);

  const pruneRuntimes = useCallback((validSessionIds: ReadonlySet<string>) => {
    const invalid = Object.entries(runtimesRef.current).filter(
      ([sessionId]) => !validSessionIds.has(sessionId),
    );
    for (const [sessionId, runtime] of invalid) {
      remoteFilesControllerRef.current!.removeSession(sessionId);
      devicePollingControllerRef.current!.removeSession(sessionId);
      if (runtime.connection) {
        // 会话已从界面移除，断开属于尽力清理；失败不能形成未处理 Promise。
        void api.disconnectSession(runtime.connection.connectionId).catch(() => undefined);
      }
      runtimeControllerRef.current.removeSession(sessionId);
    }
    if (invalid.length > 0) {
      setRuntimes((current) => {
        const next = { ...current };
        invalid.forEach(([sessionId]) => delete next[sessionId]);
        runtimesRef.current = next;
        return next;
      });
    }
  }, []);

  const attachTransferJob = useCallback(
    async (job: TransferJobSummary) => {
      const generation = runtimeControllerRef.current.beginTransfer(
        job.runtimeId,
        job.connectionId,
        job.jobId,
      );
      const isCurrent = () => {
        const runtime = runtimesRef.current[job.runtimeId];
        return (
          runtimeControllerRef.current.isTransferCurrent(
            job.runtimeId,
            job.connectionId,
            job.jobId,
            generation,
          ) &&
          (!runtime?.connection || runtime.connection.connectionId === job.connectionId)
        );
      };
      const subscription = createTransferJobSubscription({
        jobId: job.jobId,
        runtimeId: job.runtimeId,
        connectionId: job.connectionId,
        isCurrent,
        onConflict: async (conflictJob) => {
          const overwrite = await confirm(
            conflictJob.direction === "upload"
              ? i18n.t("sessions.remoteOverwriteConfirm", {
                  name: conflictJob.fileName,
                })
              : i18n.t("sessions.localOverwriteConfirm"),
            {
              title: i18n.t("sessions.overwriteTitle"),
              kind: "warning",
              okLabel: i18n.t("sessions.overwrite"),
              cancelLabel:
                conflictJob.direction === "upload"
                  ? i18n.t("sessions.skip")
                  : i18n.t("sessions.cancel"),
            },
          );
          if (overwrite) return "overwrite";
          return conflictJob.direction === "upload" ? "skip" : "cancel";
        },
        onTerminal: (terminalJob) => {
          if (terminalJob.direction !== "upload") return;
          const runtime = runtimesRef.current[terminalJob.runtimeId];
          if (runtime?.connection?.connectionId === terminalJob.connectionId) {
            void loadFiles(
              terminalJob.runtimeId,
              terminalJob.connectionId,
              runtime.currentPath,
            );
          }
        },
        resolveConflict: (jobId, decision) =>
          api.resolveTransferJobConflict(jobId, decision),
        resolveError: (error) => resolveApiError(error, errorFallbackRef.current),
        updateRuntime,
      });
      attachedTransferJobsRef.current.add(job.jobId);
      await subscription.apply(job);
      try {
        // 安装通道会先发送有序摘要；RPC 返回值可能比后续进度旧，不能再次覆盖界面。
        await api.attachTransferJob(job.jobId, subscription.channel);
      } catch (error) {
        attachedTransferJobsRef.current.delete(job.jobId);
        if (isCurrent()) {
          updateRuntime(job.runtimeId, (runtime) => ({
            ...runtime,
            error: resolveApiError(error, errorFallbackRef.current),
          }));
        }
        throw error;
      }
    },
    [loadFiles, updateRuntime],
  );

  useEffect(() => {
    const restoredJobs = getInitialLightweightModeState().transferJobs;
    const attachedJobs = attachedTransferJobsRef.current;
    for (const job of restoredJobs) {
      if (attachedJobs.has(job.jobId)) continue;
      void attachTransferJob(job).catch(() => undefined);
    }
    return () => {
      restoredJobs.forEach((job) => attachedJobs.delete(job.jobId));
    };
  }, [attachTransferJob]);

  const uploadFiles = useCallback(
    async (sessionId: string, localPaths: string[]) => {
      const paths = localPaths.filter(Boolean);
      const runtime = runtimesRef.current[sessionId];
      if (
        paths.length === 0 ||
        !runtime?.connection?.sftpAvailable ||
        runtime.transfer?.state === "running"
      ) {
        return;
      }
      const connectionId = runtime.connection.connectionId;
      const startToken = crypto.randomUUID();
      if (!runtimeControllerRef.current.startUploadBatch(sessionId, startToken)) return;
      const isStartCurrent = () =>
        runtimeControllerRef.current.isUploadBatchCurrent(sessionId, startToken) &&
        runtimesRef.current[sessionId]?.connection?.connectionId === connectionId;
      try {
        if (runtime.transfer) {
          await api.acknowledgeTransferJob(runtime.transfer.id).catch(() => undefined);
        }
        const job = await api.startTransferJob({
          kind: "uploadBatch",
          runtimeId: sessionId,
          connectionId,
          localPaths: paths,
          remoteDirectory: runtime.currentPath,
        });
        // WebView 卸载不撤销 Rust 已接管的任务；仅仍存活的界面负责取消旧连接任务。
        if (!runtimeControllerRef.current.isActive()) return;
        if (!isStartCurrent()) {
          await api.cancelTransfer(job.jobId).catch(() => undefined);
          return;
        }
        await attachTransferJob(job);
      } catch (error) {
        if (!isStartCurrent()) return;
        updateRuntime(sessionId, (current) => ({
          ...current,
          transfer: current.transfer?.connectionId === connectionId ? null : current.transfer,
          error: resolveApiError(error, errorFallback),
        }));
      } finally {
        runtimeControllerRef.current.endUploadBatch(sessionId, startToken);
      }
    },
    [attachTransferJob, errorFallback, updateRuntime],
  );

  const uploadFile = useCallback(
    async (sessionId: string) => {
      const initialConnectionId = runtimesRef.current[sessionId]?.connection?.connectionId;
      try {
        const runtime = runtimesRef.current[sessionId];
        if (
          !runtime?.connection?.sftpAvailable ||
          runtime.transfer?.state === "running"
        ) {
          return;
        }
        const selected = await open({
          directory: false,
          multiple: false,
          title: i18n.t("sessions.selectUploadFile"),
        });
        if (
          selected && runtimeControllerRef.current.isActive() &&
          runtimesRef.current[sessionId]?.connection?.connectionId === initialConnectionId
        ) {
          await uploadFiles(sessionId, [selected]);
        }
      } catch (error) {
        if (
          !runtimeControllerRef.current.isActive() ||
          !initialConnectionId ||
          runtimesRef.current[sessionId]?.connection?.connectionId !== initialConnectionId
        ) {
          return;
        }
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          transfer: null,
          error: resolveApiError(error, errorFallback),
        }));
      }
    },
    [errorFallback, updateRuntime, uploadFiles],
  );

  const downloadFile = useCallback(
    async (sessionId: string, file: FileEntry) => {
      const initialConnectionId = runtimesRef.current[sessionId]?.connection?.connectionId;
      const startToken = crypto.randomUUID();
      const isStartCurrent = () =>
        runtimeControllerRef.current.isUploadBatchCurrent(sessionId, startToken) &&
        runtimesRef.current[sessionId]?.connection?.connectionId === initialConnectionId;
      try {
        const runtime = runtimesRef.current[sessionId];
        if (
          !runtime?.connection?.sftpAvailable ||
          runtime.transfer?.state === "running" ||
          file.kind !== "file"
        ) {
          return;
        }
        if (!runtimeControllerRef.current.startUploadBatch(sessionId, startToken)) return;
        const selected = await save({
          defaultPath: file.name,
          title: i18n.t("sessions.saveDownloadFile"),
        });
        if (!selected) {
          return;
        }
        const selectedRuntime = runtimesRef.current[sessionId];
        if (
          !isStartCurrent() ||
          !selectedRuntime?.connection?.sftpAvailable ||
          selectedRuntime.connection.connectionId !== initialConnectionId ||
          selectedRuntime.transfer?.state === "running"
        ) {
          return;
        }
        const connectionId = selectedRuntime.connection.connectionId;
        if (selectedRuntime.transfer) {
          await api
            .acknowledgeTransferJob(selectedRuntime.transfer.id)
            .catch(() => undefined);
        }
        const job = await api.startTransferJob({
          kind: "download",
          runtimeId: sessionId,
          connectionId,
          remotePath: file.path,
          localPath: selected,
        });
        if (!runtimeControllerRef.current.isActive()) return;
        if (!isStartCurrent()) {
          await api.cancelTransfer(job.jobId).catch(() => undefined);
          return;
        }
        await attachTransferJob(job);
      } catch (error) {
        if (!isStartCurrent()) return;
        runtimeControllerRef.current.cancelTransfer(sessionId);
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          transfer:
            runtime.transfer?.connectionId === initialConnectionId
              ? null
              : runtime.transfer,
          error: resolveApiError(error, errorFallback),
        }));
      } finally {
        runtimeControllerRef.current.endUploadBatch(sessionId, startToken);
      }
    },
    [attachTransferJob, errorFallback, updateRuntime],
  );

  const cancelTransfer = useCallback(
    async (sessionId: string) => {
      const transfer = runtimesRef.current[sessionId]?.transfer;
      if (!transfer || transfer.state !== "running") {
        return;
      }
      try {
        await api.cancelTransfer(transfer.id);
      } catch (error) {
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          error:
            runtime.transfer?.id === transfer.id
              ? resolveApiError(error, errorFallback)
              : runtime.error,
        }));
      }
    },
    [errorFallback, updateRuntime],
  );

  const dismissTransfer = useCallback(
    async (sessionId: string) => {
      const transfer = runtimesRef.current[sessionId]?.transfer;
      if (!transfer || transfer.state === "running") return;
      try {
        await api.acknowledgeTransferJob(transfer.id);
      } catch (error) {
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          error:
            runtime.transfer?.id === transfer.id
              ? resolveApiError(error, errorFallback)
              : runtime.error,
        }));
        return;
      }
      runtimeControllerRef.current.cancelTransfer(sessionId);
      attachedTransferJobsRef.current.delete(transfer.id);
      updateRuntime(sessionId, (runtime) =>
        runtime.transfer?.id === transfer.id ? { ...runtime, transfer: null } : runtime,
      );
    },
    [errorFallback, updateRuntime],
  );

  return {
    cancelTransfer,
    createRemoteDirectory,
    deleteRemoteEntry,
    dismissTransfer,
    disconnect,
    downloadFile,
    handleConnected,
    handleTerminalDirectory,
    handleTerminalState,
    moveRemoteEntry,
    openPath,
    pruneRuntimes,
    refreshFiles,
    refreshSession,
    renameRemoteEntry,
    removeRuntime,
    runtimes,
    uploadFile,
    uploadFiles,
  };
}

export function createRuntime(): SessionRuntime {
  return {
    connectionState: "disconnected",
    connection: null,
    error: null,
    currentPath: DEFAULT_REMOTE_PATH,
    files: [],
    filesLoading: false,
    deviceLoading: false,
    deviceStatus: null,
    deviceHistory: [],
    deviceWindowEndMs: 0,
    transfer: null,
  };
}

function normalizeRemotePath(path: string) {
  if (
    !path.startsWith("/") ||
    new TextEncoder().encode(path).byteLength > 4096 ||
    hasControlCharacter(path)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}
