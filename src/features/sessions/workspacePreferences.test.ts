import { describe, expect, it } from "vitest";
import { normalizeCollapsedGroupNames } from "./workspacePreferences";

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
