import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../shared/api/types";
import {
  buildBreadcrumbs,
  canMoveRemoteEntry,
  createModifiedTimeFormatter,
  formatModifiedTime,
  formatSize,
  isRemoteMoveCandidate,
  remoteParentPath,
} from "./fileUtils";

function remoteEntry(kind: FileEntry["kind"], path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind,
    owner: "root",
    group: "root",
    permissions: "rw-r--r--",
  };
}

describe("远程文件路径", () => {
  it("生成父目录和面包屑", () => {
    expect(remoteParentPath("/var/log/app.log")).toBe("/var/log");
    expect(remoteParentPath("/app.log")).toBe("/");
    expect(buildBreadcrumbs("/var/log")).toEqual([
      { label: "/", path: "/" },
      { label: "var", path: "/var" },
      { label: "log", path: "/var/log" },
    ]);
  });

  it("只允许普通文件和文件夹参与移动", () => {
    expect(isRemoteMoveCandidate(remoteEntry("file", "/file"))).toBe(true);
    expect(isRemoteMoveCandidate(remoteEntry("folder", "/folder"))).toBe(true);
    expect(isRemoteMoveCandidate(remoteEntry("symlink", "/link"))).toBe(false);
    expect(isRemoteMoveCandidate(remoteEntry("other", "/other"))).toBe(false);
  });

  it("拒绝同目录、自身和子目录目标", () => {
    const file = remoteEntry("file", "/home/file.txt");
    const folder = remoteEntry("folder", "/home/project");
    expect(canMoveRemoteEntry(file, "/home")).toBe(false);
    expect(canMoveRemoteEntry(file, "/archive")).toBe(true);
    expect(canMoveRemoteEntry(folder, "/home/project")).toBe(false);
    expect(canMoveRemoteEntry(folder, "/home/project/build")).toBe(false);
    expect(canMoveRemoteEntry(folder, "/archive")).toBe(true);
  });
});

describe("文件展示格式", () => {
  it("格式化文件大小边界", () => {
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("根据应用语言选择日期区域", () => {
    const chinese = createModifiedTimeFormatter("zh-CN");
    const english = createModifiedTimeFormatter("en-US");
    expect(chinese.resolvedOptions().locale).toBe("zh-CN");
    expect(english.resolvedOptions().locale).toBe("en-US");
    expect(formatModifiedTime(null, chinese)).toBe("--");
  });
});
