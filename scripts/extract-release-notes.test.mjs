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
