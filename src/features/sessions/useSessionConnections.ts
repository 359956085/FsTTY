import { Channel } from "@tauri-apps/api/core";
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
  TransferEvent,
} from "../../shared/api/types";
import { DEFAULT_REMOTE_PATH } from "./constants";
import {
  appendDeviceMetricSample,
  DEVICE_POLL_INTERVAL_MS,
  type DeviceMetricSample,
} from "./deviceMetrics";
import { createTransferSpeedTracker } from "./fileUtils";
import { createSessionRuntimeController } from "./sessionRuntimeController";

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
  const runtimeControllerRef = useRef(createSessionRuntimeController());
  const pendingTerminalPathsRef = useRef(new Map<string, string>());

  useEffect(() => {
    runtimesRef.current = runtimes;
  }, [runtimes]);

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

  const stopDevicePolling = useCallback((sessionId: string) => {
    runtimeControllerRef.current.stopDevicePoll(sessionId);
  }, []);

  useEffect(
    () => () => {
      runtimeControllerRef.current.dispose();
    },
    [],
  );

  const loadFiles = useCallback(
    async (sessionId: string, connectionId: string, path: string) => {
      const requestId = runtimeControllerRef.current.beginFileRequest(sessionId);
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        currentPath: path,
        files: [],
        filesLoading: true,
        error: null,
      }));
      try {
        const files = await api.listRemoteFiles(connectionId, path);
        if (!runtimeControllerRef.current.isFileRequestCurrent(sessionId, requestId)) {
          return false;
        }
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          files,
          filesLoading: false,
        }));
        return true;
      } catch (error) {
        if (!runtimeControllerRef.current.isFileRequestCurrent(sessionId, requestId)) {
          return false;
        }
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          filesLoading: false,
          error: resolveApiError(error, errorFallback),
        }));
        return false;
      }
    },
    [errorFallback, updateRuntime],
  );

  const loadDevice = useCallback(
    async (sessionId: string, connectionId: string) => {
      const requestId = runtimeControllerRef.current.beginDeviceRequest(sessionId);
      try {
        const deviceStatus = await api.getDeviceStatus(connectionId);
        const runtime = runtimesRef.current[sessionId];
        if (
          !runtimeControllerRef.current.isDeviceRequestCurrent(sessionId, requestId) ||
          runtime?.connection?.connectionId !== connectionId
        ) {
          return false;
        }
        const sample = appendDeviceMetricSample(
          runtime.deviceHistory,
          deviceStatus,
          performance.now(),
          runtimeControllerRef.current.getDeviceCounter(sessionId),
        );
        if (sample.networkCounter) {
          runtimeControllerRef.current.setDeviceCounter(sessionId, sample.networkCounter);
        } else {
          runtimeControllerRef.current.deleteDeviceCounter(sessionId);
        }
        updateRuntime(sessionId, (current) => ({
          ...current,
          deviceStatus,
          deviceHistory: sample.history,
        }));
        return true;
      } catch {
        return false;
      }
    },
    [updateRuntime],
  );

  const startDevicePolling = useCallback(
    (sessionId: string, connectionId: string) => {
      const pollId = runtimeControllerRef.current.startDevicePoll(sessionId);
      const poll = async () => {
        await loadDevice(sessionId, connectionId);
        if (
          !runtimeControllerRef.current.isDevicePollCurrent(sessionId, pollId) ||
          runtimesRef.current[sessionId]?.connection?.connectionId !== connectionId
        ) {
          return;
        }
        const timer = window.setTimeout(() => {
          runtimeControllerRef.current.clearDeviceTimer(sessionId);
          void poll();
        }, DEVICE_POLL_INTERVAL_MS);
        runtimeControllerRef.current.setDeviceTimer(sessionId, timer);
      };
      void poll();
    },
    [loadDevice],
  );

  const handleConnected = useCallback(
    (sessionId: string, connection: SshConnection) => {
      // 登录提示符可能先于 connectSession 返回 OSC；缓存保证首次目录上报不丢失。
      const currentPath =
        pendingTerminalPathsRef.current.get(sessionId) ||
        connection.homePath ||
        DEFAULT_REMOTE_PATH;
      pendingTerminalPathsRef.current.delete(sessionId);
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        connectionState: "connected",
        connection,
        error: null,
        currentPath,
        files: [],
        deviceStatus: null,
        deviceHistory: [],
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
        pendingTerminalPathsRef.current.delete(sessionId);
      }
      if (state === "disconnected" || state === "error") {
        runtimeControllerRef.current.cancelUploadBatch(sessionId);
        runtimeControllerRef.current.cancelFileRequest(sessionId);
        stopDevicePolling(sessionId);
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
          state === "disconnected" || state === "error" ? null : runtime.transfer,
      }));
    },
    [stopDevicePolling, updateRuntime],
  );

  const openPath = useCallback(
    (sessionId: string, path: string) => {
      const runtime = runtimesRef.current[sessionId];
      if (!runtime?.connection?.sftpAvailable) {
        return;
      }
      const normalizedPath = normalizeRemotePath(path);
      if (!normalizedPath) {
        return;
      }
      const connectionId = runtime.connection.connectionId;
      void loadFiles(sessionId, connectionId, normalizedPath);
    },
    [loadFiles],
  );

  const handleTerminalDirectory = useCallback(
    (sessionId: string, path: string) => {
      const normalizedPath = normalizeRemotePath(path);
      const runtime = runtimesRef.current[sessionId];
      if (!normalizedPath) {
        return;
      }
      pendingTerminalPathsRef.current.set(sessionId, normalizedPath);
      if (!runtime?.connection?.sftpAvailable || runtime.currentPath === normalizedPath) return;
      void loadFiles(sessionId, runtime.connection.connectionId, normalizedPath);
    },
    [loadFiles],
  );

  const refreshFiles = useCallback(
    (sessionId: string) => {
      const runtime = runtimesRef.current[sessionId];
      if (!runtime?.connection?.sftpAvailable || runtime.filesLoading) {
        return;
      }
      void loadFiles(sessionId, runtime.connection.connectionId, runtime.currentPath);
    },
    [loadFiles],
  );

  const runRemoteMutation = useCallback(
    async (
      sessionId: string,
      mutation: (connectionId: string, currentPath: string) => Promise<void>,
    ) => {
      const runtime = runtimesRef.current[sessionId];
      if (!runtime?.connection?.sftpAvailable) {
        throw new Error(i18n.t("sessions.sftpOperationUnavailable"));
      }
      if (runtime.filesLoading || runtime.transfer?.state === "running") {
        throw new Error(i18n.t("sessions.fileOperationBusy"));
      }
      const connectionId = runtime.connection.connectionId;
      const currentPath = runtime.currentPath;
      try {
        await mutation(connectionId, currentPath);
      } finally {
        const latest = runtimesRef.current[sessionId];
        if (
          latest?.connection?.connectionId === connectionId &&
          latest.currentPath === currentPath
        ) {
          await loadFiles(sessionId, connectionId, currentPath);
        }
      }
    },
    [loadFiles],
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
    async (sessionId: string) => {
      const runtime = runtimesRef.current[sessionId];
      if (!runtime?.connection || runtime.filesLoading) {
        return;
      }
      const tasks: Promise<unknown>[] = [];
      if (runtime.connection.sftpAvailable) {
        tasks.push(
          loadFiles(
            sessionId,
            runtime.connection.connectionId,
            runtime.currentPath,
          ),
        );
      }
      await Promise.all(tasks);
    },
    [loadFiles],
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
    pendingTerminalPathsRef.current.delete(sessionId);
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
      pendingTerminalPathsRef.current.delete(sessionId);
      if (runtime.connection) {
        void api.disconnectSession(runtime.connection.connectionId);
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
            const progress = createTransferChannel(
              sessionId,
              transferId,
              "upload",
              fileName,
              updateRuntime,
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
              return batchIsActive() ? "uploaded" : "cancelled";
            } catch (error) {
              const info = readApiError(error, errorFallback);
              if (info.kind === "conflict" && !overwrite) {
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
                  clearTransfer(transferId);
                  return "failed";
                }
                if (!batchIsActive()) {
                  clearTransfer(transferId);
                  return "cancelled";
                }
                if (accepted) {
                  return run(true);
                }
                clearTransfer(transferId);
                return "skipped";
              }
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
          !selectedRuntime?.connection?.sftpAvailable ||
          selectedRuntime.transfer?.state === "running"
        ) {
          return;
        }
        const connectionId = selectedRuntime.connection.connectionId;

        const run = async (overwrite: boolean): Promise<void> => {
          const transferId = crypto.randomUUID();
          const progress = createTransferChannel(
            sessionId,
            transferId,
            "download",
            file.name,
            updateRuntime,
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
            const info = readApiError(error, errorFallback);
            if (info.kind === "conflict" && !overwrite) {
              const accepted = await confirm(i18n.t("sessions.localOverwriteConfirm"), {
                title: i18n.t("sessions.overwriteTitle"),
                kind: "warning",
                okLabel: i18n.t("sessions.overwrite"),
                cancelLabel: i18n.t("sessions.cancel"),
              });
              if (accepted) {
                await run(true);
                return;
              }
            }
            updateRuntime(sessionId, (current) => ({
              ...current,
              transfer: current.transfer?.id === transferId ? null : current.transfer,
              error: info.message,
            }));
          }
        };
        await run(false);
      } catch (error) {
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
      try {
        await api.cancelTransfer(transfer.id);
      } catch (error) {
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          error: resolveApiError(error, errorFallback),
        }));
      }
    },
    [errorFallback, updateRuntime],
  );

  const dismissTransfer = useCallback(
    (sessionId: string) => {
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

function createTransferChannel(
  sessionId: string,
  transferId: string,
  direction: TransferProgress["direction"],
  fileName: string,
  updateRuntime: (
    sessionId: string,
    update: (runtime: SessionRuntime) => SessionRuntime,
  ) => void,
  batchIndex?: number,
  batchTotal?: number,
) {
  const channel = new Channel<TransferEvent>();
  const speedTracker = createTransferSpeedTracker();
  const initialSpeed = speedTracker.update(0, performance.now());
  channel.onmessage = (event) => {
    if (event.transferId !== transferId) {
      return;
    }
    const speed = speedTracker.update(event.transferredBytes, performance.now());
    updateRuntime(sessionId, (runtime) => ({
      ...runtime,
      transfer: {
        id: transferId,
        direction,
        fileName,
        batchIndex,
        batchTotal,
        transferredBytes: event.transferredBytes,
        totalBytes: event.totalBytes,
        ...speed,
        state:
          event.kind === "completed"
            ? "completed"
            : event.kind === "cancelled"
              ? "cancelled"
              : "running",
      },
    }));
  };
  updateRuntime(sessionId, (runtime) => ({
    ...runtime,
    error: null,
    transfer: {
      id: transferId,
      direction,
      fileName,
      batchIndex,
      batchTotal,
      transferredBytes: 0,
      totalBytes: 0,
      ...initialSpeed,
      state: "running",
    },
  }));
  return channel;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || i18n.t("sessions.fallbackFileName");
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
