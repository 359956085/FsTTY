// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, StrictMode } from "react";
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
  onDownloadFiles?: (files: FileEntry[]) => void;
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
      onDeleteEntries={async (paths) => {
        const failures = [];
        for (const path of paths) {
          try { await options.onDeleteEntry?.(path); }
          catch (error) { failures.push({ path, message: String(error) }); }
        }
        return failures;
      }}
      onDismissTransfer={vi.fn()}
      onDownload={vi.fn()}
      onDownloadFiles={options.onDownloadFiles ?? vi.fn()}
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
  const rendered = render(options.strict ? <StrictMode>{pane}</StrictMode> : pane);
  return {
    ...rendered,
    rerenderFiles: (nextFiles: FileEntry[], currentPath = "/srv/apps", loading = false) =>
      rendered.rerender(cloneElement(pane, { files: nextFiles, currentPath, loading })),
  };
}

describe("FilesPane 批量选择与操作", () => {
  const files: FileEntry[] = Array.from({ length: 7 }, (_, index) => ({
    name: `file-${index}.txt`, path: `/srv/apps/file-${index}.txt`,
    kind: "file", owner: "root", group: "root", permissions: "-rw-r--r--",
  }));
  const row = (index: number) => screen.getByRole("button", { name: files[index].name });
  const selected = () => files.filter((file) =>
    screen.getByRole("button", { name: file.name }).getAttribute("aria-pressed") === "true",
  ).map((file) => file.name);

  it("Ctrl 点击添加或取消选择，普通点击恢复单选", () => {
    renderFilesPane(files);
    fireEvent.click(row(1));
    fireEvent.pointerDown(row(4), { button: 0, isPrimary: true, ctrlKey: true, pointerId: 1 });
    fireEvent.click(row(4), { ctrlKey: true });
    expect(selected()).toEqual([files[1].name, files[4].name]);
    fireEvent.click(row(1), { ctrlKey: true });
    expect(selected()).toEqual([files[4].name]);
    fireEvent.click(row(5), { metaKey: true });
    expect(selected()).toEqual([files[4].name, files[5].name]);
    fireEvent.click(row(2));
    expect(selected()).toEqual([files[2].name]);
  });

  it("Shift 使用显示顺序和固定锚点选择范围，Ctrl+Shift 添加范围", () => {
    renderFilesPane(files);
    fireEvent.click(row(0));
    fireEvent.click(row(3), { shiftKey: true });
    expect(selected()).toEqual(files.slice(0, 4).map((file) => file.name));
    fireEvent.click(row(1), { shiftKey: true });
    expect(selected()).toEqual(files.slice(0, 2).map((file) => file.name));
    fireEvent.click(row(5), { ctrlKey: true });
    fireEvent.click(row(3), { ctrlKey: true, shiftKey: true });
    expect(selected()).toEqual([0, 1, 3, 4, 5].map((index) => files[index].name));
    expect(screen.queryByRole("textbox", { name: "sessions.renameRemoteEntry" })).toBeNull();
  });

  it("点击列表空白清除多选及菜单，下一次 Shift 点击重新建立范围起点", () => {
    const rendered = renderFilesPane(files);
    fireEvent.click(row(0));
    fireEvent.click(row(6), { shiftKey: true });
    fireEvent.contextMenu(row(3));
    expect(selected()).toEqual(files.map((file) => file.name));

    fireEvent.click(rendered.container.querySelector(".file-table")!);

    expect(selected()).toEqual([]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rendered.container.querySelector(".file-selection-count")).toBeNull();
    fireEvent.click(row(4), { shiftKey: true });
    expect(selected()).toEqual([files[4].name]);
    fireEvent.click(row(2), { shiftKey: true });
    expect(selected()).toEqual(files.slice(2, 5).map((file) => file.name));
  });

  it("点击列标题和刷新按钮保留选区，点击文件名只选择该文件", () => {
    const rendered = renderFilesPane(files);
    fireEvent.click(row(0));
    fireEvent.click(row(3), { shiftKey: true });

    fireEvent.click(screen.getByText("sessions.name"));
    fireEvent.click(screen.getByRole("button", { name: "sessions.refresh" }));
    expect(selected()).toEqual(files.slice(0, 4).map((file) => file.name));

    fireEvent.click(row(5).querySelector(".file-name-text")!);
    expect(selected()).toEqual([files[5].name]);
    fireEvent.click(rendered.container.querySelector(".file-table")!);
    expect(selected()).toEqual([]);
  });

  it("右键已选条目保留多选，菜单仅包含下载和删除，并下载整个选区", () => {
    const onDownloadFiles = vi.fn();
    renderFilesPane(files, { onDownloadFiles });
    fireEvent.click(row(0));
    fireEvent.click(row(6), { shiftKey: true });
    fireEvent.contextMenu(row(3));
    expect(selected()).toEqual(files.map((file) => file.name));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "sessions.download", "sessions.deleteRemoteEntry",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.download" }));
    expect(onDownloadFiles).toHaveBeenCalledExactlyOnceWith(files);
  });

  it("右键未选条目切换到该条目的单选菜单", () => {
    renderFilesPane(files);
    fireEvent.click(row(1), { shiftKey: true });
    fireEvent.contextMenu(row(5));
    expect(selected()).toEqual([files[5].name]);
    expect(screen.getByRole("menuitem", { name: "sessions.renameRemoteEntry" })).toBeDefined();
  });

  it("混合文件夹选择仍有下载和删除菜单，下载禁用", () => {
    renderFilesPane([{ ...files[0], kind: "folder" }, ...files.slice(1)]);
    fireEvent.click(row(1), { shiftKey: true });
    fireEvent.contextMenu(row(0));
    expect(screen.getByRole("menuitem", { name: "sessions.download" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "sessions.deleteRemoteEntry" }).hasAttribute("disabled")).toBe(false);
  });

  it("刷新保留仍存在的选项，目录切换重置选区和范围锚点", () => {
    const rendered = renderFilesPane(files);
    fireEvent.click(row(0));
    fireEvent.click(row(3), { shiftKey: true });
    rendered.rerenderFiles([], "/srv/apps", true);
    rendered.rerenderFiles(files);
    expect(selected()).toEqual(files.slice(0, 4).map((file) => file.name));
    rendered.rerenderFiles(files, "/another");
    expect(selected()).toEqual([files[0].name]);
    fireEvent.click(row(2), { shiftKey: true });
    expect(selected()).toEqual(files.slice(0, 3).map((file) => file.name));
  });

  it("批量删除一次确认所有条目，部分失败继续删除并仅重试失败项", async () => {
    const onDeleteEntry = vi.fn(async (path: string): Promise<void> => {
      if (path === files[1].path && onDeleteEntry.mock.calls.filter(([deleted]) => deleted === path).length === 1) {
        throw new Error("permission denied");
      }
    });
    const rendered = renderFilesPane(files, { onDeleteEntry });
    fireEvent.click(row(0));
    fireEvent.click(row(2), { shiftKey: true });
    fireEvent.contextMenu(row(1));
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.deleteRemoteEntry" }));
    expect(rendered.container.querySelectorAll(".file-operation-entries code")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    await waitFor(() => expect(onDeleteEntry).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(rendered.container.querySelectorAll(".file-operation-entries code")).toHaveLength(1));
    expect(rendered.container.querySelector(".file-operation-entries")?.textContent).toBe(files[1].path);
    fireEvent.click(screen.getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onDeleteEntry.mock.calls.map(([path]) => path)).toEqual([
      files[0].path, files[1].path, files[2].path, files[1].path,
    ]);
  });
});

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
