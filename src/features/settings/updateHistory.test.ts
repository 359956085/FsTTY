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
  it("beta 按序号倒序排列，同基础正式版优先且不混入未识别区块", () => {
    const fixture = ["2.1.0-beta.2", "2.1.0-beta.10", "2.1.0", "2.0.0"].map(version =>
      `## [${version}] - 2026-10-11\n<!-- release-notes:zh-CN:start -->中文 ${version}<!-- release-notes:zh-CN:end -->\n<!-- release-notes:en-US:start -->English ${version}<!-- release-notes:en-US:end -->\n## [Unreleased]\n不要混入`).join("\n");
    for (const language of ["zh-CN", "en-US"]) {
      const entries = parseUpdateHistory(fixture, language);
      expect(entries.map(entry => entry.version)).toEqual(["2.1.0", "2.1.0-beta.10", "2.1.0-beta.2", "2.0.0"]);
      expect(entries.every(entry => !entry.notes.includes("不要混入"))).toBe(true);
    }
  });
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
