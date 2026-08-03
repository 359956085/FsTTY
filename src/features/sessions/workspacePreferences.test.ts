// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeCollapsedGroupNames,
  readWorkspacePreferences,
  updateWorkspacePreferences,
  WORKSPACE_STORAGE_KEY,
} from "./workspacePreferences";

beforeEach(() => window.localStorage.clear());

describe("normalizeCollapsedGroupNames", () => {
  it("去重并保留合法分组名称的原始顺序", () => {
    expect(
      normalizeCollapsedGroupNames(["生产", "测试", "生产", "未分组"]),
    ).toEqual(["生产", "测试", "未分组"]);
  });

  it("过滤空值、首尾空格、控制字符和超长名称", () => {
    expect(
      normalizeCollapsedGroupNames([
        "",
        " 测试",
        "测试 ",
        "测\u0000试",
        "a".repeat(129),
        "有效分组",
        42,
      ]),
    ).toEqual(["有效分组"]);
  });

  it("最多保留一百个分组", () => {
    const names = Array.from({ length: 101 }, (_, index) => `分组-${index}`);

    expect(normalizeCollapsedGroupNames(names)).toEqual(names.slice(0, 100));
  });
});

describe("历史命令弹窗偏好", () => {
  it("旧偏好和损坏尺寸回退到自适应布局", () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ layout: {} }));
    expect(readWorkspacePreferences().commandHistoryPopover).toBeNull();

    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ commandHistoryPopover: { width: "400", height: 300 } }),
    );
    expect(readWorkspacePreferences().commandHistoryPopover).toBeNull();
  });

  it("保存尺寸并限制非法边界值", () => {
    expect(
      updateWorkspacePreferences({
        commandHistoryPopover: { width: 100, height: 10_000 },
      }).commandHistoryPopover,
    ).toEqual({ width: 220, height: 4096 });
    expect(readWorkspacePreferences().commandHistoryPopover).toEqual({
      width: 220,
      height: 4096,
    });
  });
});
