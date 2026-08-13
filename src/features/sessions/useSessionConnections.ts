import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { readApiError, resolveApiError } from "../../shared/api/errors";
import i18n from "../../shared/i18n";
import { hasControlCharacter } from "../../shared/validation/text";
import type {
  ConnectionState,
  DeviceStatus,
  FileEntry,
  SshConnection,
} from "../../shared/api/types";
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
import { createTransferChannel, fileNameFromPath } from "./sessionTransfer";

export interface TransferProgress {
  id: string;
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
  deviceStatus: DeviceStatus | null;
  deviceHistory: DeviceMetricSample[];
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
        getDeviceStatus: (connectionId) => api.getDeviceStatus(connectionId),
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
      runtimeControllerRef.current.cancelTransfer(sessionId);
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
        deviceStatus: null,
        deviceHistory: [],
        transfer: null,
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
      if (state === "connecting" || state === "disconnected" || state === "error") {
        remoteFilesControllerRef.current!.cancelSession(sessionId);
        runtimeControllerRef.current.cancelUploadBatch(sessionId);
        runtimeControllerRef.current.cancelTransfer(sessionId);
      }
      if (state === "disconnected" || state === "error") {
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
        deviceStatus:
          state === "disconnected" || state === "error"
            ? null
            : runtime.deviceStatus,
        deviceHistory:
          state === "disconnected" || state === "error"
            ? []
            : runtime.deviceHistory,
        transfer:
          state === "connecting" || state === "disconnected" || state === "error"
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

  const uploadFiles = useCallback(
    async (sessionId: string, localPaths: string[]) => {
      const paths = localPaths.filter(Boolean);
      const runtime = runtimesRef.current[sessionId];
      if (
        paths.length === 0 ||
        !runtime?.connection?.sftpAvailable ||
        runtime.transfer?.state === "running" ||
        runtimeControllerRef.current.hasUploadBatch(sessionId)
      ) {
        return;
      }

      const connectionId = runtime.connection.connectionId;
      const remoteDirectory = runtime.currentPath;
      const batchToken = crypto.randomUUID();
      if (!runtimeControllerRef.current.startUploadBatch(sessionId, batchToken)) return;
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let cancelled = false;

      const batchIsActive = () =>
        runtimeControllerRef.current.isUploadBatchCurrent(sessionId, batchToken) &&
        runtimesRef.current[sessionId]?.connection?.connectionId === connectionId;
      const clearTransfer = (transferId: string) => {
        updateRuntime(sessionId, (current) => ({
          ...current,
          transfer: current.transfer?.id === transferId ? null : current.transfer,
        }));
      };

      try {
        for (const [index, localPath] of paths.entries()) {
          if (!batchIsActive()) {
            cancelled = true;
            break;
          }
          const fileName = fileNameFromPath(localPath);
          const run = async (
            overwrite: boolean,
          ): Promise<"uploaded" | "skipped" | "failed" | "cancelled"> => {
            const transferId = crypto.randomUUID();
            const transferGeneration = runtimeControllerRef.current.beginTransfer(
              sessionId,
              connectionId,
              transferId,
            );
            const transferIsCurrent = () =>
              batchIsActive() &&
              runtimeControllerRef.current.isTransferCurrent(
                sessionId,
                connectionId,
                transferId,
                transferGeneration,
              );
            const progress = createTransferChannel(
              sessionId,
              transferId,
              "upload",
              fileName,
              updateRuntime,
              transferIsCurrent,
              index + 1,
              paths.length,
            );
            try {
              await api.uploadFile(
                connectionId,
                transferId,
                localPath,
                remoteDirectory,
                overwrite,
                progress,
              );
              return transferIsCurrent() ? "uploaded" : "cancelled";
            } catch (error) {
              if (!transferIsCurrent()) return "cancelled";
              const info = readApiError(error, errorFallback);
              if (info.kind === "conflict" && !overwrite) {
                runtimeControllerRef.current.cancelTransfer(sessionId);
                clearTransfer(transferId);
                let accepted = false;
                try {
                  accepted = await confirm(
                    i18n.t("sessions.remoteOverwriteConfirm", { name: fileName }),
                    {
                      title: i18n.t("sessions.overwriteTitle"),
                      kind: "warning",
                      okLabel: i18n.t("sessions.overwrite"),
                      cancelLabel: i18n.t("sessions.skip"),
                    },
                  );
                } catch {
                  return "failed";
                }
                if (!batchIsActive()) {
                  return "cancelled";
                }
                if (accepted) {
                  return run(true);
                }
                return "skipped";
              }
              runtimeControllerRef.current.cancelTransfer(sessionId);
              clearTransfer(transferId);
              return "failed";
            }
          };

          const result = await run(false);
          if (result === "cancelled") {
            cancelled = true;
            break;
          }
          if (result === "uploaded") uploaded += 1;
          if (result === "skipped") skipped += 1;
          if (result === "failed") failed += 1;
        }
      } finally {
        const ownsBatch = runtimeControllerRef.current.endUploadBatch(sessionId, batchToken);
        if (ownsBatch) runtimeControllerRef.current.cancelTransfer(sessionId);
        const latest = runtimesRef.current[sessionId];
        let refreshSucceeded = true;
        if (
          (ownsBatch || cancelled) &&
          latest?.connection?.connectionId === connectionId &&
          latest.currentPath === remoteDirectory
        ) {
          refreshSucceeded = await loadFiles(sessionId, connectionId, remoteDirectory);
        }
        if (ownsBatch && refreshSucceeded && (skipped > 0 || failed > 0)) {
          updateRuntime(sessionId, (current) => ({
            ...current,
            error: i18n.t("sessions.batchUploadSummary", {
              uploaded,
              skipped,
              failed,
            }),
          }));
        }
      }
    },
    [errorFallback, loadFiles, updateRuntime],
  );

  const uploadFile = useCallback(
    async (sessionId: string) => {
      const initialConnectionId = runtimesRef.current[sessionId]?.connection?.connectionId;
      try {
        const runtime = runtimesRef.current[sessionId];
        if (
          !runtime?.connection?.sftpAvailable ||
          runtime.transfer?.state === "running" ||
          runtimeControllerRef.current.hasUploadBatch(sessionId)
        ) {
          return;
        }
        const selected = await open({
          directory: false,
          multiple: false,
          title: i18n.t("sessions.selectUploadFile"),
        });
        if (selected) {
          await uploadFiles(sessionId, [selected]);
        }
      } catch (error) {
        if (
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
      try {
        const runtime = runtimesRef.current[sessionId];
        if (
          !runtime?.connection?.sftpAvailable ||
          runtime.transfer?.state === "running" ||
          file.kind !== "file"
        ) {
          return;
        }
        const selected = await save({
          defaultPath: file.name,
          title: i18n.t("sessions.saveDownloadFile"),
        });
        if (!selected) {
          return;
        }
        const selectedRuntime = runtimesRef.current[sessionId];
        if (
          !runtimeControllerRef.current.isActive() ||
          !selectedRuntime?.connection?.sftpAvailable ||
          selectedRuntime.transfer?.state === "running"
        ) {
          return;
        }
        const connectionId = selectedRuntime.connection.connectionId;

        const run = async (overwrite: boolean): Promise<void> => {
          const transferId = crypto.randomUUID();
          const transferGeneration = runtimeControllerRef.current.beginTransfer(
            sessionId,
            connectionId,
            transferId,
          );
          const transferIsCurrent = () =>
            runtimeControllerRef.current.isTransferCurrent(
              sessionId,
              connectionId,
              transferId,
              transferGeneration,
            ) &&
            runtimesRef.current[sessionId]?.connection?.connectionId === connectionId;
          const progress = createTransferChannel(
            sessionId,
            transferId,
            "download",
            file.name,
            updateRuntime,
            transferIsCurrent,
          );
          try {
            await api.downloadFile(
              connectionId,
              transferId,
              file.path,
              selected,
              overwrite,
              progress,
            );
          } catch (error) {
            if (!transferIsCurrent()) return;
            const info = readApiError(error, errorFallback);
            if (info.kind === "conflict" && !overwrite) {
              runtimeControllerRef.current.cancelTransfer(sessionId);
              updateRuntime(sessionId, (current) => ({
                ...current,
                transfer: current.transfer?.id === transferId ? null : current.transfer,
              }));
              const accepted = await confirm(i18n.t("sessions.localOverwriteConfirm"), {
                title: i18n.t("sessions.overwriteTitle"),
                kind: "warning",
                okLabel: i18n.t("sessions.overwrite"),
                cancelLabel: i18n.t("sessions.cancel"),
              });
              if (
                accepted &&
                runtimeControllerRef.current.isActive() &&
                runtimesRef.current[sessionId]?.connection?.connectionId === connectionId
              ) {
                await run(true);
                return;
              }
              return;
            }
            runtimeControllerRef.current.cancelTransfer(sessionId);
            updateRuntime(sessionId, (current) => ({
              ...current,
              transfer: current.transfer?.id === transferId ? null : current.transfer,
              error: info.message,
            }));
          }
        };
        await run(false);
      } catch (error) {
        if (
          !initialConnectionId ||
          runtimesRef.current[sessionId]?.connection?.connectionId !== initialConnectionId
        ) {
          return;
        }
        runtimeControllerRef.current.cancelTransfer(sessionId);
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          transfer: null,
          error: resolveApiError(error, errorFallback),
        }));
      }
    },
    [errorFallback, updateRuntime],
  );

  const cancelTransfer = useCallback(
    async (sessionId: string) => {
      runtimeControllerRef.current.cancelUploadBatch(sessionId);
      const transfer = runtimesRef.current[sessionId]?.transfer;
      if (!transfer || transfer.state !== "running") {
        return;
      }
      runtimeControllerRef.current.cancelTransfer(sessionId);
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        transfer:
          runtime.transfer?.id === transfer.id
            ? { ...runtime.transfer, state: "cancelled" }
            : runtime.transfer,
      }));
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
    (sessionId: string) => {
      const transfer = runtimesRef.current[sessionId]?.transfer;
      if (transfer && transfer.state !== "running") {
        runtimeControllerRef.current.cancelTransfer(sessionId);
      }
      updateRuntime(sessionId, (runtime) =>
        runtime.transfer?.state === "running"
          ? runtime
          : { ...runtime, transfer: null },
      );
    },
    [updateRuntime],
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
    deviceStatus: null,
    deviceHistory: [],
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
