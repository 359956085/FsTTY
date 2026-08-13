import { describe, expect, it, vi } from "vitest";
import type { FileEntry, SshConnection } from "../../shared/api/types";
import { createSessionRemoteFilesController } from "./sessionRemoteFiles";

interface Runtime {
  connection: SshConnection | null;
  currentPath: string;
  files: FileEntry[];
  filesLoading: boolean;
  error: string | null;
  transfer: null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function entry(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind: "file",
    owner: "root",
    group: "root",
    permissions: "rw-r--r--",
  };
}

function createHarness() {
  const runtimes: Record<string, Runtime> = {
    session: {
      connection: {
        connectionId: "connection-1",
        sessionId: "session",
        homePath: "/home",
        sftpAvailable: true,
      },
      currentPath: "/home",
      files: [],
      filesLoading: false,
      error: null,
      transfer: null,
    },
  };
  const listFiles = vi.fn<(connectionId: string, path: string) => Promise<FileEntry[]>>();
  const controller = createSessionRemoteFilesController<Runtime>({
    defaultPath: "/",
    getRuntime: (sessionId) => runtimes[sessionId],
    listFiles,
    normalizePath: (path) => (path.startsWith("/") ? path : null),
    operationBusyError: () => "busy",
    operationUnavailableError: () => "unavailable",
    resolveError: (error) => String(error),
    updateRuntime: (sessionId, update) => {
      const runtime = runtimes[sessionId];
      if (runtime) runtimes[sessionId] = update(runtime);
    },
  });
  return { controller, listFiles, runtimes };
}

describe("远程文件请求控制器", () => {
  it("只接受最后一次目录响应", async () => {
    const first = deferred<FileEntry[]>();
    const second = deferred<FileEntry[]>();
    const { controller, listFiles, runtimes } = createHarness();
    listFiles.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstLoad = controller.loadFiles("session", "connection-1", "/old");
    const secondLoad = controller.loadFiles("session", "connection-1", "/new");
    second.resolve([entry("/new/new.txt")]);
    await expect(secondLoad).resolves.toBe(true);
    first.resolve([entry("/old/old.txt")]);
    await expect(firstLoad).resolves.toBe(false);

    expect(runtimes.session.currentPath).toBe("/new");
    expect(runtimes.session.files).toEqual([entry("/new/new.txt")]);
  });

  it.each(["cancelSession", "removeSession", "dispose"] as const)(
    "%s 后丢弃晚到响应",
    async (method) => {
      const pending = deferred<FileEntry[]>();
      const { controller, listFiles, runtimes } = createHarness();
      listFiles.mockReturnValueOnce(pending.promise);
      const load = controller.loadFiles("session", "connection-1", "/late");

      if (method === "dispose") controller.dispose();
      else controller[method]("session");
      pending.resolve([entry("/late/file.txt")]);

      await expect(load).resolves.toBe(false);
      expect(runtimes.session.files).toEqual([]);
    },
  );

  it("重建激活后旧请求仍失效，新请求可完成", async () => {
    const oldRequest = deferred<FileEntry[]>();
    const { controller, listFiles, runtimes } = createHarness();
    listFiles.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce([entry("/new.txt")]);
    const oldLoad = controller.loadFiles("session", "connection-1", "/old");

    controller.dispose();
    controller.activate();
    await expect(controller.loadFiles("session", "connection-1", "/new")).resolves.toBe(true);
    oldRequest.resolve([entry("/old.txt")]);
    await expect(oldLoad).resolves.toBe(false);

    expect(runtimes.session.files).toEqual([entry("/new.txt")]);
  });

  it("连接前终端目录作为首次目录消费一次", () => {
    const { controller } = createHarness();
    controller.handleTerminalDirectory("pending", "/srv/app");

    expect(controller.consumeInitialPath("pending", "/home/user")).toBe("/srv/app");
    expect(controller.consumeInitialPath("pending", "/home/user")).toBe("/home/user");
  });
});
