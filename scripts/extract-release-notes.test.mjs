import { readFileSync } from "node:fs";
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
  it("从真实日志提取 v1.5.0 的三项双语说明和保护边界", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(changelog).toContain("## [1.5.0] - 2026-09-18");
    const notes = extractVersionReleaseNotes(changelog, "v1.5.0");
    expect(notes.match(/^- /gm)).toHaveLength(6);
    for (const expected of [
      "Windows 新增独立 SSH 凭据服务",
      "未提权恶意程序直接读取已托管",
      "优化 UI、布局与交互体验。",
      "将应用更新中的代理地址移至「常规 → 基础设置」，改为全局代理",
      "不代表阻止所有注入攻击。",
      "Added an independent SSH credential service on Windows",
      "preventing unelevated malware",
      "Improved the UI, layout, and interaction experience.",
      "Moved the application update proxy address to General → Basic Settings",
      "does not prevent all injection attacks.",
      "<!-- release-notes:zh-CN:start -->",
      "<!-- release-notes:en-US:start -->",
    ]) {
      expect(notes).toContain(expected);
    }
    expect(notes).not.toContain("Unreleased");
    expect(notes).not.toContain("## [1.4.0]");
    expect(notes).not.toContain("新增 Windows 当前用户开机自启");
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
