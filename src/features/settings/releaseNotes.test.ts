import { describe, expect, it } from "vitest";
import { selectLocalizedReleaseNotes } from "./releaseNotes";

const bilingualNotes = `
<!-- release-notes:zh-CN:start -->
### 简体中文
- 优化更新按钮
- 更新说明来自 CHANGELOG
<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English
- Improved the update button
- Release notes now come from CHANGELOG
<!-- release-notes:en-US:end -->
`;

describe("更新说明语言选择", () => {
  it("按当前界面语言提取说明并移除语言标题", () => {
    expect(selectLocalizedReleaseNotes(bilingualNotes, "zh-CN")).toBe(
      "- 优化更新按钮\n- 更新说明来自 CHANGELOG",
    );
    expect(selectLocalizedReleaseNotes(bilingualNotes, "en-US")).toBe(
      "- Improved the update button\n- Release notes now come from CHANGELOG",
    );
  });

  it("缺少首选语言时回退到另一语言", () => {
    const chineseOnly = `
<!-- release-notes:zh-CN:start -->
- 中文说明
<!-- release-notes:zh-CN:end -->`;
    expect(selectLocalizedReleaseNotes(chineseOnly, "en-US")).toBe("- 中文说明");
  });

  it("兼容旧版无语言标记说明", () => {
    expect(selectLocalizedReleaseNotes("  旧版更新说明  ", "en-US")).toBe("旧版更新说明");
    expect(selectLocalizedReleaseNotes(undefined, "zh-CN")).toBeNull();
  });
});
