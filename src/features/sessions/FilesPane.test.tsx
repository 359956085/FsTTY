// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../shared/api/types";
import { FilesPane } from "./FilesPane";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
    scaleFactor: vi.fn().mockResolvedValue(1),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" },
    t: (key: string) => key,
  }),
}));

const writeText = vi.fn<(text: string) => Promise<void>>();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

interface RenderFilesPaneOptions {
  onCreateDirectory?: (name: string) => Promise<void>;
  onDeleteEntry?: (path: string) => Promise<void>;
  onMoveEntry?: (sourcePath: string, targetDirectory: string) => Promise<void>;
  onRenameEntry?: (path: string, newName: string) => Promise<void>;
  strict?: boolean;
}

function deferred<T>() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((_resolve, nextReject) => {
    reject = nextReject;
  });
  return { promise, reject };
}

function renderFilesPane(files: FileEntry[] = [], options: RenderFilesPaneOptions = {}) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  writeText.mockResolvedValue();

  const pane = (
    <FilesPane
      currentPath="/srv/apps"
      files={files}
      loading={false}
      onCancelTransfer={vi.fn()}
      onCollapse={vi.fn()}
      onCreateDirectory={options.onCreateDirectory ?? vi.fn().mockResolvedValue(undefined)}
      onDeleteEntry={options.onDeleteEntry ?? vi.fn().mockResolvedValue(undefined)}
      onDismissTransfer={vi.fn()}
      onDownload={vi.fn()}
      onMoveEntry={options.onMoveEntry ?? vi.fn().mockResolvedValue(undefined)}
      onOpenPath={vi.fn()}
      onRefresh={vi.fn()}
      onRenameEntry={options.onRenameEntry ?? vi.fn().mockResolvedValue(undefined)}
      onUpload={vi.fn()}
      onUploadFiles={vi.fn()}
      sftpAvailable
      transfer={null}
    />
  );
  return render(options.strict ? <StrictMode>{pane}</StrictMode> : pane);
}

describe("FilesPane 文件表头", () => {
  it("为前三列提供可访问的列宽分隔手柄", () => {
    renderFilesPane();

    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(3);
    for (const separator of separators) {
      expect(separator.getAttribute("aria-orientation")).toBe("vertical");
      expect(separator.classList.contains("file-column-resizer")).toBe(true);
    }
  });
});

describe("FilesPane 右键菜单", () => {
  it("空白区域复制当前文件夹路径", async () => {
    const rendered = renderFilesPane();
    const fileTable = rendered.container.querySelector<HTMLElement>(".file-table");
    expect(fileTable).not.toBeNull();

    fireEvent.contextMenu(fileTable!);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "sessions.contextCopyCurrentFolderPath",
      }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/srv/apps"));
  });

  it("文件条目仍复制自身路径，不打开目录菜单", async () => {
    renderFilesPane([
      {
        group: "root",
        kind: "file",
        name: "notes.txt",
        owner: "root",
        path: "/srv/apps/notes.txt",
        permissions: "-rw-r--r--",
      },
    ]);

    fireEvent.contextMenu(screen.getByRole("button", { name: "notes.txt" }));

    expect(
      screen.queryByRole("menuitem", {
        name: "sessions.contextCopyCurrentFolderPath",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.contextCopyPath" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("/srv/apps/notes.txt"),
    );
  });

  it("复制路径失败时显示现有剪贴板错误", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const rendered = renderFilesPane();
    const fileTable = rendered.container.querySelector<HTMLElement>(".file-table");

    fireEvent.contextMenu(fileTable!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "sessions.contextCopyCurrentFolderPath" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "sessions.clipboardWriteFailed",
    );
  });

  it("卸载后忽略晚到的剪贴板失败", async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    const rendered = renderFilesPane();
    const fileTable = rendered.container.querySelector<HTMLElement>(".file-table");
    fireEvent.contextMenu(fileTable!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "sessions.contextCopyCurrentFolderPath" }),
    );

    rendered.unmount();
    pending.reject(new Error("clipboard unavailable"));
    await Promise.resolve();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("StrictMode 重放后文件增删改操作各执行一次", async () => {
    const file: FileEntry = {
      group: "root",
      kind: "file",
      name: "notes.txt",
      owner: "root",
      path: "/srv/apps/notes.txt",
      permissions: "-rw-r--r--",
    };
    const onCreateDirectory = vi.fn().mockResolvedValue(undefined);
    const onDeleteEntry = vi.fn().mockResolvedValue(undefined);
    const onRenameEntry = vi.fn().mockResolvedValue(undefined);
    const rendered = renderFilesPane([file], {
      onCreateDirectory,
      onDeleteEntry,
      onRenameEntry,
      strict: true,
    });
    const fileTable = rendered.container.querySelector<HTMLElement>(".file-table");
    expect(fileTable).not.toBeNull();

    fireEvent.contextMenu(fileTable!);
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.createDirectory" }));
    fireEvent.change(screen.getByLabelText("sessions.directoryName"), {
      target: { value: "archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sessions.save" }));
    await waitFor(() => expect(onCreateDirectory).toHaveBeenCalledWith("archive"));

    fireEvent.contextMenu(screen.getByRole("button", { name: "notes.txt" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.renameRemoteEntry" }));
    fireEvent.change(screen.getByLabelText("sessions.newName"), {
      target: { value: "renamed.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "sessions.save" }));
    await waitFor(() =>
      expect(onRenameEntry).toHaveBeenCalledWith("/srv/apps/notes.txt", "renamed.txt"),
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "notes.txt" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.deleteRemoteEntry" }));
    fireEvent.click(screen.getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    await waitFor(() => expect(onDeleteEntry).toHaveBeenCalledWith("/srv/apps/notes.txt"));

    expect(onCreateDirectory).toHaveBeenCalledTimes(1);
    expect(onRenameEntry).toHaveBeenCalledTimes(1);
    expect(onDeleteEntry).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 重放后仍能拖动文件完成移动", async () => {
    const source: FileEntry = {
      group: "root",
      kind: "file",
      name: "notes.txt",
      owner: "root",
      path: "/srv/apps/notes.txt",
      permissions: "-rw-r--r--",
    };
    const target: FileEntry = {
      group: "root",
      kind: "folder",
      name: "archive",
      owner: "root",
      path: "/srv/apps/archive",
      permissions: "drwxr-xr-x",
    };
    const onMoveEntry = vi.fn().mockResolvedValue(undefined);
    renderFilesPane([source, target], { onMoveEntry, strict: true });
    const sourceRow = screen.getByRole("button", { name: "notes.txt" });
    const targetRow = screen.getByRole("button", { name: "archive" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(sourceRow, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
      setPointerCapture: { configurable: true, value: setPointerCapture },
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => targetRow),
    });

    fireEvent.pointerDown(sourceRow, {
      button: 0,
      clientX: 10,
      clientY: 10,
      isPrimary: true,
      pointerId: 7,
    });
    fireEvent.pointerMove(sourceRow, {
      clientX: 30,
      clientY: 10,
      isPrimary: true,
      pointerId: 7,
    });
    fireEvent.pointerUp(sourceRow, {
      clientX: 30,
      clientY: 10,
      isPrimary: true,
      pointerId: 7,
    });

    await waitFor(() =>
      expect(onMoveEntry).toHaveBeenCalledWith(
        "/srv/apps/notes.txt",
        "/srv/apps/archive",
      ),
    );
    expect(onMoveEntry).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
