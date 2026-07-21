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

export interface TransferProgress {
  id: string;
  direction: "upload" | "download";
  fileName: string;
  batchIndex?: number;
  batchTotal?: number;
  transferredBytes: number;
  totalBytes: number;
  state: "running" | "completed" | "cancelled";
}

export interface TerminalDirectoryRequest {
  id: number;
  path: string;
}

export interface SessionRuntime {
  connectionState: ConnectionState;
  connection: SshConnection | null;
  error: string | null;
  currentPath: string;
  files: FileEntry[];
  filesLoading: boolean;
  deviceStatus: DeviceStatus | null;
  transfer: TransferProgress | null;
  terminalDirectoryRequest: TerminalDirectoryRequest | null;
}

interface UseSessionConnectionsOptions {
  errorFallback: string;
}

export function useSessionConnections({ errorFallback }: UseSessionConnectionsOptions) {
  const [runtimes, setRuntimes] = useState<Record<string, SessionRuntime>>({});
  const runtimesRef = useRef(runtimes);
  const fileRequestIds = useRef(new Map<string, number>());
  const deviceRequestIds = useRef(new Map<string, number>());
  // 后端继续处理单文件；批次令牌只负责前端串行排队和整批取消。
  const uploadBatchTokens = useRef(new Map<string, string>());
  const terminalDirectoryRequestId = useRef(0);

  useEffect(() => {
    runtimesRef.current = runtimes;
  }, [runtimes]);

  const updateRuntime = useCallback(
    (sessionId: string, update: (runtime: SessionRuntime) => SessionRuntime) => {
      setRuntimes((current) => {
        const next = {
          ...current,
          [sessionId]: update(current[sessionId] ?? createRuntime()),
        };
        runtimesRef.current = next;
        return next;
      });
    },
    [],
  );

  const loadFiles = useCallback(
    async (sessionId: string, connectionId: string, path: string) => {
      const requestId = (fileRequestIds.current.get(sessionId) ?? 0) + 1;
      fileRequestIds.current.set(sessionId, requestId);
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        currentPath: path,
        files: [],
        filesLoading: true,
        error: null,
      }));
      try {
        const files = await api.listRemoteFiles(connectionId, path);
        if (fileRequestIds.current.get(sessionId) !== requestId) {
          return false;
        }
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          files,
          filesLoading: false,
        }));
        return true;
      } catch (error) {
        if (fileRequestIds.current.get(sessionId) !== requestId) {
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
      const requestId = (deviceRequestIds.current.get(sessionId) ?? 0) + 1;
      deviceRequestIds.current.set(sessionId, requestId);
      try {
        const deviceStatus = await api.getDeviceStatus(connectionId);
        if (deviceRequestIds.current.get(sessionId) !== requestId) {
          return;
        }
        updateRuntime(sessionId, (runtime) => ({ ...runtime, deviceStatus }));
      } catch {
        if (deviceRequestIds.current.get(sessionId) === requestId) {
          updateRuntime(sessionId, (runtime) => ({ ...runtime, deviceStatus: null }));
        }
      }
    },
    [updateRuntime],
  );

  const handleConnected = useCallback(
    (sessionId: string, connection: SshConnection) => {
      const currentPath = connection.homePath || DEFAULT_REMOTE_PATH;
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        connectionState: "connected",
        connection,
        error: null,
        currentPath,
        files: [],
        deviceStatus: null,
        terminalDirectoryRequest: null,
      }));
      if (connection.sftpAvailable) {
        void loadFiles(sessionId, connection.connectionId, currentPath);
      }
      void loadDevice(sessionId, connection.connectionId);
    },
    [loadDevice, loadFiles, updateRuntime],
  );

  const handleTerminalState = useCallback(
    (sessionId: string, state: ConnectionState, error: string | null = null) => {
      if (state === "disconnected" || state === "error") {
        uploadBatchTokens.current.delete(sessionId);
        fileRequestIds.current.set(
          sessionId,
          (fileRequestIds.current.get(sessionId) ?? 0) + 1,
        );
        deviceRequestIds.current.set(
          sessionId,
          (deviceRequestIds.current.get(sessionId) ?? 0) + 1,
        );
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
        transfer:
          state === "disconnected" || state === "error" ? null : runtime.transfer,
        terminalDirectoryRequest:
          state === "disconnected" || state === "error"
            ? null
            : runtime.terminalDirectoryRequest,
      }));
    },
    [updateRuntime],
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
      void loadFiles(sessionId, connectionId, normalizedPath).then((opened) => {
        const current = runtimesRef.current[sessionId];
        if (!opened || current?.connection?.connectionId !== connectionId) {
          return;
        }
        updateRuntime(sessionId, (latest) => ({
          ...latest,
          terminalDirectoryRequest: {
            id: ++terminalDirectoryRequestId.current,
            path: normalizedPath,
          },
        }));
      });
    },
    [loadFiles, updateRuntime],
  );

  const handleTerminalDirectory = useCallback(
    (sessionId: string, path: string) => {
      const normalizedPath = normalizeRemotePath(path);
      const runtime = runtimesRef.current[sessionId];
      if (
        !normalizedPath ||
        !runtime?.connection?.sftpAvailable ||
        runtime.currentPath === normalizedPath
      ) {
        return;
      }
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
      const tasks: Promise<unknown>[] = [
        loadDevice(sessionId, runtime.connection.connectionId),
      ];
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
    [loadDevice, loadFiles],
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
    fileRequestIds.current.delete(sessionId);
    deviceRequestIds.current.delete(sessionId);
    uploadBatchTokens.current.delete(sessionId);
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
      if (runtime.connection) {
        void api.disconnectSession(runtime.connection.connectionId);
      }
      fileRequestIds.current.delete(sessionId);
      deviceRequestIds.current.delete(sessionId);
      uploadBatchTokens.current.delete(sessionId);
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
        uploadBatchTokens.current.has(sessionId)
      ) {
        return;
      }

      const connectionId = runtime.connection.connectionId;
      const remoteDirectory = runtime.currentPath;
      const batchToken = crypto.randomUUID();
      uploadBatchTokens.current.set(sessionId, batchToken);
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let cancelled = false;

      const batchIsActive = () =>
        uploadBatchTokens.current.get(sessionId) === batchToken &&
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
        const ownsBatch = uploadBatchTokens.current.get(sessionId) === batchToken;
        if (ownsBatch) {
          uploadBatchTokens.current.delete(sessionId);
        }
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
          uploadBatchTokens.current.has(sessionId)
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
      uploadBatchTokens.current.delete(sessionId);
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
    transfer: null,
    terminalDirectoryRequest: null,
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
  channel.onmessage = (event) => {
    if (event.transferId !== transferId) {
      return;
    }
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
