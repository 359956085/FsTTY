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
});
