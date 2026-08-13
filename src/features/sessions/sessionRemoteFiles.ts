import type { FileEntry, SshConnection } from "../../shared/api/types";

interface RemoteFilesRuntime {
  connection: SshConnection | null;
  currentPath: string;
  files: FileEntry[];
  filesLoading: boolean;
  error: string | null;
  transfer: { state: string } | null;
}

interface SessionRemoteFilesControllerOptions<TRuntime extends RemoteFilesRuntime> {
  defaultPath: string;
  getRuntime: (sessionId: string) => TRuntime | undefined;
  listFiles: (connectionId: string, path: string) => Promise<FileEntry[]>;
  normalizePath: (path: string) => string | null;
  resolveError: (error: unknown) => string;
  operationBusyError: () => string;
  operationUnavailableError: () => string;
  updateRuntime: (
    sessionId: string,
    update: (runtime: TRuntime) => TRuntime,
  ) => void;
}

export interface SessionRemoteFilesController {
  activate: () => void;
  cancelSession: (sessionId: string) => void;
  consumeInitialPath: (sessionId: string, homePath: string | null | undefined) => string;
  dispose: () => void;
  handleTerminalDirectory: (sessionId: string, path: string) => void;
  loadFiles: (sessionId: string, connectionId: string, path: string) => Promise<boolean>;
  openPath: (sessionId: string, path: string) => void;
  refreshFiles: (sessionId: string) => void;
  refreshSession: (sessionId: string) => Promise<void>;
  removeSession: (sessionId: string) => void;
  runMutation: (
    sessionId: string,
    mutation: (connectionId: string, currentPath: string) => Promise<void>,
  ) => Promise<void>;
}

export function createSessionRemoteFilesController<TRuntime extends RemoteFilesRuntime>(
  options: SessionRemoteFilesControllerOptions<TRuntime>,
): SessionRemoteFilesController {
  let active = true;
  const requests = new Map<string, number>();
  const pendingTerminalPaths = new Map<string, string>();

  const advanceRequest = (sessionId: string) => {
    const next = (requests.get(sessionId) ?? 0) + 1;
    requests.set(sessionId, next);
    return next;
  };

  const requestIsCurrent = (
    sessionId: string,
    connectionId: string,
    requestId: number,
  ) =>
    active &&
    requests.get(sessionId) === requestId &&
    options.getRuntime(sessionId)?.connection?.connectionId === connectionId;

  const cancelSession = (sessionId: string) => {
    // 保留递增后的墓碑，避免同一会话快速重建时旧请求与新请求编号碰撞。
    advanceRequest(sessionId);
    pendingTerminalPaths.delete(sessionId);
  };

  const loadFiles = async (sessionId: string, connectionId: string, path: string) => {
    if (!active) return false;
    const requestId = advanceRequest(sessionId);
    options.updateRuntime(sessionId, (runtime) => ({
      ...runtime,
      currentPath: path,
      files: [],
      filesLoading: true,
      error: null,
    }));
    try {
      const files = await options.listFiles(connectionId, path);
      if (!requestIsCurrent(sessionId, connectionId, requestId)) return false;
      options.updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        files,
        filesLoading: false,
      }));
      return true;
    } catch (error) {
      if (!requestIsCurrent(sessionId, connectionId, requestId)) return false;
      options.updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        filesLoading: false,
        error: options.resolveError(error),
      }));
      return false;
    }
  };

  return {
    activate: () => {
      active = true;
    },
    cancelSession,
    consumeInitialPath: (sessionId, homePath) => {
      const path = pendingTerminalPaths.get(sessionId) || homePath || options.defaultPath;
      pendingTerminalPaths.delete(sessionId);
      return path;
    },
    dispose: () => {
      active = false;
      for (const sessionId of requests.keys()) advanceRequest(sessionId);
      pendingTerminalPaths.clear();
    },
    handleTerminalDirectory: (sessionId, path) => {
      const normalizedPath = options.normalizePath(path);
      if (!normalizedPath) return;
      pendingTerminalPaths.set(sessionId, normalizedPath);
      const runtime = options.getRuntime(sessionId);
      if (!runtime?.connection?.sftpAvailable || runtime.currentPath === normalizedPath) return;
      void loadFiles(sessionId, runtime.connection.connectionId, normalizedPath);
    },
    loadFiles,
    openPath: (sessionId, path) => {
      const runtime = options.getRuntime(sessionId);
      if (!runtime?.connection?.sftpAvailable) return;
      const normalizedPath = options.normalizePath(path);
      if (!normalizedPath) return;
      void loadFiles(sessionId, runtime.connection.connectionId, normalizedPath);
    },
    refreshFiles: (sessionId) => {
      const runtime = options.getRuntime(sessionId);
      if (!runtime?.connection?.sftpAvailable || runtime.filesLoading) return;
      void loadFiles(sessionId, runtime.connection.connectionId, runtime.currentPath);
    },
    refreshSession: async (sessionId) => {
      const runtime = options.getRuntime(sessionId);
      if (!runtime?.connection?.sftpAvailable || runtime.filesLoading) return;
      await loadFiles(sessionId, runtime.connection.connectionId, runtime.currentPath);
    },
    removeSession: cancelSession,
    runMutation: async (sessionId, mutation) => {
      const runtime = options.getRuntime(sessionId);
      if (!runtime?.connection?.sftpAvailable) {
        throw new Error(options.operationUnavailableError());
      }
      if (runtime.filesLoading || runtime.transfer?.state === "running") {
        throw new Error(options.operationBusyError());
      }
      const connectionId = runtime.connection.connectionId;
      const currentPath = runtime.currentPath;
      try {
        await mutation(connectionId, currentPath);
      } finally {
        const latest = options.getRuntime(sessionId);
        if (
          active &&
          latest?.connection?.connectionId === connectionId &&
          latest.currentPath === currentPath
        ) {
          await loadFiles(sessionId, connectionId, currentPath);
        }
      }
    },
  };
}
