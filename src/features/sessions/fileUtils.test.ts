import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../shared/api/types";
import {
  buildBreadcrumbs,
  canMoveRemoteEntry,
  createTransferSpeedTracker,
  createModifiedTimeFormatter,
  formatModifiedTime,
  formatSize,
  formatTransferSpeed,
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

  it("格式化传输速度单位边界", () => {
    expect(formatTransferSpeed(0)).toBe("0 B/s");
    expect(formatTransferSpeed(1023)).toBe("1023 B/s");
    expect(formatTransferSpeed(1024)).toBe("1.0 KB/s");
    expect(formatTransferSpeed(1024 * 1024)).toBe("1.0 MB/s");
    expect(formatTransferSpeed(1024 * 1024 * 1024)).toBe("1.0 GB/s");
    expect(formatTransferSpeed(Number.NaN)).toBe("0 B/s");
  });
});

describe("传输速度滑动窗口", () => {
  it("使用最近一秒样本计算速度", () => {
    const tracker = createTransferSpeedTracker();
    expect(tracker.update(0, 0).speedBytesPerSecond).toBe(0);
    expect(tracker.update(512, 500).speedBytesPerSecond).toBe(1024);
    expect(tracker.update(1024, 1000).speedBytesPerSecond).toBe(1024);
    expect(tracker.update(2048, 1500).speedBytesPerSecond).toBe(1536);
  });

  it("字节倒退时重置且不继承旧速度", () => {
    const tracker = createTransferSpeedTracker();
    tracker.update(0, 0);
    tracker.update(1024, 1000);
    const reset = tracker.update(0, 1100);
    expect(reset.speedBytesPerSecond).toBe(0);
    expect(reset.speedUpdatedAtMs).toBe(1100);
    expect(tracker.update(1024, 2100).speedBytesPerSecond).toBe(1024);
  });

  it("忽略无进度事件并处理异常时间", () => {
    const tracker = createTransferSpeedTracker();
    tracker.update(0, 100);
    const progress = tracker.update(100, 200);
    expect(tracker.update(100, 300)).toEqual(progress);
    expect(tracker.update(200, 150).speedBytesPerSecond).toBe(0);
    expect(tracker.update(300, Number.NaN)).toEqual({
      speedBytesPerSecond: 0,
      speedUpdatedAtMs: 0,
    });
  });
});
