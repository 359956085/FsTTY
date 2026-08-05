import { describe, expect, it } from "vitest";
import i18n from "./index";

type ResourceValue = string | { [key: string]: ResourceValue };

function flattenResource(
  value: ResourceValue,
  prefix = "",
  result = new Map<string, string>(),
) {
  if (typeof value === "string") {
    result.set(prefix, value);
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    flattenResource(child, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

describe("i18n 资源", () => {
  const chinese = flattenResource(
    i18n.getResourceBundle("zh-CN", "translation") as ResourceValue,
  );
  const english = flattenResource(
    i18n.getResourceBundle("en-US", "translation") as ResourceValue,
  );

  it("中英文资源键完全一致", () => {
    expect([...english.keys()].sort()).toEqual([...chinese.keys()].sort());
  });

  it("英文资源除语言名称外不含中文", () => {
    const chineseTextEntries = [...english.entries()].filter(
      ([key, value]) => key !== "settings.chinese" && /[\u3400-\u9fff]/u.test(value),
    );
    expect(chineseTextEntries).toEqual([]);
  });

  it("默认分组具有双语显示文案", () => {
    expect(chinese.get("sessions.ungrouped")).toBe("未分组");
    expect(english.get("sessions.ungrouped")).toBe("Ungrouped");
  });

  it("高级命令管理使用白名单黑名单和完成文案", () => {
    expect(chinese.get("settings.mcpCommandPolicyAllow")).toBe("白名单");
    expect(chinese.get("settings.mcpCommandPolicyExclude")).toBe("黑名单");
    expect(chinese.get("settings.mcpCommandPolicyEnable")).toBe("启用");
    expect(chinese.get("settings.mcpCommandPolicyComplete")).toBe("完成");
    expect(english.get("settings.mcpCommandPolicyAllow")).toBe("Allowlist");
    expect(english.get("settings.mcpCommandPolicyExclude")).toBe("Blocklist");
    expect(english.get("settings.mcpCommandPolicyComplete")).toBe("Done");
  });

  it("高级命令管理使用简短操作和动态占位文案", () => {
    expect(chinese.get("settings.mcpCommandPolicyImport")).toBe("导入");
    expect(chinese.get("settings.mcpCommandPolicyExport")).toBe("导出");
    expect(chinese.get("settings.mcpCommandPolicyPatternPlaceholderExact")).toBe(
      "输入完整命令",
    );
    expect(chinese.get("settings.mcpCommandPolicyPatternPlaceholderGlob")).toBe(
      "输入 Glob 规则",
    );
    expect(english.get("settings.mcpCommandPolicyImport")).toBe("Import");
    expect(english.get("settings.mcpCommandPolicyExport")).toBe("Export");
    expect(english.get("settings.mcpCommandPolicyPatternPlaceholderExact")).toBe(
      "Enter a complete command",
    );
    expect(english.get("settings.mcpCommandPolicyPatternPlaceholderGlob")).toBe(
      "Enter a glob pattern",
    );
  });
});
