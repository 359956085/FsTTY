// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderFilesPane(files: FileEntry[] = []) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  writeText.mockResolvedValue();

  return render(
    <FilesPane
      currentPath="/srv/apps"
      files={files}
      loading={false}
      onCancelTransfer={vi.fn()}
      onCollapse={vi.fn()}
      onCreateDirectory={vi.fn().mockResolvedValue(undefined)}
      onDeleteEntry={vi.fn().mockResolvedValue(undefined)}
      onDismissTransfer={vi.fn()}
      onDownload={vi.fn()}
      onMoveEntry={vi.fn().mockResolvedValue(undefined)}
      onOpenPath={vi.fn()}
      onRefresh={vi.fn()}
      onRenameEntry={vi.fn().mockResolvedValue(undefined)}
      onUpload={vi.fn()}
      onUploadFiles={vi.fn()}
      sftpAvailable
      transfer={null}
    />,
  );
}

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
});
