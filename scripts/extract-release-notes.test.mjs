import { describe, expect, it } from "vitest";
import { extractVersionReleaseNotes } from "./extract-release-notes.mjs";

const chineseBlock = `<!-- release-notes:zh-CN:start -->
### 简体中文
- 中文说明
<!-- release-notes:zh-CN:end -->`;
const englishBlock = `<!-- release-notes:en-US:start -->
### English
- English notes
<!-- release-notes:en-US:end -->`;

describe("发布更新说明提取", () => {
  it("保留可变数量的条目及段落，排除前后相邻版本", () => {
    for (const count of [0, 1, 5]) {
      const chinese = chineseBlock.replace("- 中文说明", ["中文段落", ...Array.from({ length: count }, (_, index) => `- 示例 ${index}`)].join("\n"));
      const changelog = `## [Unreleased]\n未发布内容\n## [0.4.0] - 2026-08-01\n${chinese}\n${englishBlock}\n## [0.3.0] - 2026-07-01\n历史内容`;
      expect(extractVersionReleaseNotes(changelog, "v0.4.0")).toBe(`${chinese}\n${englishBlock}`);
    }
  });

  it("缺少日期或重复语言区块时阻止发布", () => {
    expect(() => extractVersionReleaseNotes(`## [0.4.0]\n${chineseBlock}\n${englishBlock}`, "v0.4.0")).toThrow();
    expect(() => extractVersionReleaseNotes(`## [0.4.0] - 2026-08-01\n${chineseBlock}\n${englishBlock}\n${englishBlock}`, "v0.4.0")).toThrow("en-US 区块");
  });

  it("兼容 Windows 换行，拒绝不存在的日历日期", () => {
    const valid = `## [0.4.0] - 2026-08-01\n${chineseBlock}\n${englishBlock}`;
    expect(extractVersionReleaseNotes(valid.replaceAll("\n", "\r\n"), "v0.4.0"))
      .toBe(`${chineseBlock}\n${englishBlock}`.replaceAll("\r\n", "\n"));
    for (const invalid of ["2026-02-30", "2026-13-01"]) {
      expect(() => extractVersionReleaseNotes(valid.replace("2026-08-01", invalid), "v0.4.0")).toThrow("日期无效");
    }
  });
  it("按完整 beta 标签提取双语区块，不混入正式或其他 beta 内容", () => {
    const changelog = `## [2.1.0-beta.2] - 2026-10-11\n${chineseBlock}\n${englishBlock}\n## [2.1.0-beta.1] - 2026-10-10\n旧 beta\n## [2.0.0] - 2026-10-09\n正式版`;
    const notes = extractVersionReleaseNotes(changelog, "v2.1.0-beta.2");
    expect(notes).toContain("中文说明");
    expect(notes).toContain("English notes");
    expect(notes).not.toContain("旧 beta");
    expect(notes).not.toContain("正式版");
  });
  it("按标签精确提取双语版本内容", () => {
    const changelog = `# Changelog

## [0.4.0] - 2026-08-01

${chineseBlock}

${englishBlock}

## [0.3.0] - 2026-07-21

旧版本`;
    const notes = extractVersionReleaseNotes(changelog, "v0.4.0");
    expect(notes).toContain("- 中文说明");
    expect(notes).toContain("- English notes");
    expect(notes).not.toContain("旧版本");
  });

  it("缺少或重复版本时阻止发布", () => {
    expect(() => extractVersionReleaseNotes("# Changelog", "v0.4.0")).toThrow(
      "必须包含且仅包含一个 0.4.0 版本标题",
    );
    const duplicate = `## [0.4.0] - 2026-08-01
${chineseBlock}
${englishBlock}
## [0.4.0] - 2026-08-02
${chineseBlock}
${englishBlock}`;
    expect(() => extractVersionReleaseNotes(duplicate, "v0.4.0")).toThrow(
      "必须包含且仅包含一个 0.4.0 版本标题",
    );
  });

  it("缺少任一语言区块时阻止发布", () => {
    const changelog = `## [0.4.0] - 2026-08-01
${chineseBlock}`;
    expect(() => extractVersionReleaseNotes(changelog, "v0.4.0")).toThrow(
      "必须包含且仅包含一个 en-US 区块",
    );
  });

  it("拒绝只有语言标题的空区块", () => {
    const changelog = `## [0.4.0] - 2026-08-01
<!-- release-notes:zh-CN:start -->
### 简体中文
<!-- release-notes:zh-CN:end -->
${englishBlock}`;
    expect(() => extractVersionReleaseNotes(changelog, "v0.4.0")).toThrow(
      "zh-CN 更新说明不能为空",
    );
  });

  it("拒绝非标准版本标签", () => {
    expect(() => extractVersionReleaseNotes("", "main")).toThrow("发布标签必须使用 vX.Y.Z 格式");
  });
});
