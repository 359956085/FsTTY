import { describe, expect, it } from "vitest";
import { parseUpdateHistory } from "./updateHistory";

const changelog = `# Changelog

## [Unreleased]
<!-- release-notes:zh-CN:start -->未发布<!-- release-notes:zh-CN:end -->

## [1.1.0] - 2026-08-02
<!-- release-notes:zh-CN:start -->中文新版<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->English latest<!-- release-notes:en-US:end -->

## [1.0.0] - 2026-07-30
<!-- release-notes:en-US:start -->English fallback<!-- release-notes:en-US:end -->`;

describe("更新日志解析", () => {
  it("排除未发布内容并按版本倒序选择中文", () => {
    expect(parseUpdateHistory(changelog, "zh-CN")).toEqual([
      { date: "2026-08-02", notes: "中文新版", version: "1.1.0" },
      { date: "2026-07-30", notes: "English fallback", version: "1.0.0" },
    ]);
  });

  it("英文界面只选择英文区块", () => {
    const entries = parseUpdateHistory(changelog, "en-US");
    expect(entries[0]?.notes).toBe("English latest");
    expect(entries.map((entry) => entry.notes)).not.toContain("未发布");
  });
});
