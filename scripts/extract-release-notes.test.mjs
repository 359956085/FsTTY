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
  it("从真实日志提取 v1.6.2 合并后的完整说明", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(changelog).toContain("## [1.6.2] - 2026-09-19");
    const notes = extractVersionReleaseNotes(changelog, "v1.6.2");
    expect(notes.match(/^- /gm)).toHaveLength(22);
    for (const expected of [
      "publish=false",
      "UNSIGNED",
      "Windows Sandbox 或虚拟机",
      "publish=true",
      "存在关联普通令牌时",
      "内置 Administrator 或关闭 UAC",
      "随机操作 ID",
      "ProgramData 日志",
      "Authenticode 签名、时间戳与信任链门禁",
      "unsigned NSIS validation build",
      "without Authenticode",
      "Tauri updater private key",
      "When a linked standard token exists",
      "random operation ID",
      "ACL-protected ProgramData logs",
      "trusted, timestamped Authenticode signatures",
    ]) {
      expect(notes).toContain(expected);
    }
    expect(notes).not.toContain("## [1.6.1]");
    expect(notes).not.toContain("Unreleased");
  });

  it("从真实日志提取 v1.6.0 的完整双语说明", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(changelog).toContain("## [1.6.0] - 2026-09-19");
    const notes = extractVersionReleaseNotes(changelog, "v1.6.0");
    expect(notes.match(/^- /gm)).toHaveLength(12);
    for (const expected of [
      "全局代理新增独立启用开关",
      "凭据服务的状态、管理、迁移、更新及 SSH 数据管道固定通过本机命名管道直连",
      "可选择跟随应用主题或 10 套预设",
      "文件列表新增 Ctrl / Command 追加选择、Shift 连续范围选择",
      "所有会话最多同时下载 5 个文件",
      "Added an independent enable switch for the global proxy",
      "always connect through the local named pipe",
      "Follow app theme and 10 presets",
      "Added Ctrl / Command additive selection and Shift range selection",
      "run up to five files concurrently across sessions",
      "<!-- release-notes:zh-CN:start -->",
      "<!-- release-notes:en-US:start -->",
    ]) {
      expect(notes).toContain(expected);
    }
    expect(notes).not.toContain("Unreleased");
    expect(notes).not.toContain("## [1.5.0]");
    expect(notes).not.toContain("Windows 新增独立 SSH 凭据服务，提高其他应用访问凭据所需权限");
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
