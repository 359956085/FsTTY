import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  normalizeReleaseVersion,
  shouldSuppressUpdate,
} from "./updateVersion";

describe("更新版本比较", () => {
  it("规范化版本并按数字比较", () => {
    expect(normalizeReleaseVersion(" v0.5.0 ")).toBe("0.5.0");
    expect(compareReleaseVersions("0.5.0", "0.5.0")).toBe(0);
    expect(compareReleaseVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareReleaseVersions("0.4.9", "0.5.0")).toBe(-1);
  });

  it("自动检查抑制已忽略及更低版本", () => {
    expect(shouldSuppressUpdate("automatic", "0.5.0", "0.5.0")).toBe(true);
    expect(shouldSuppressUpdate("automatic", "0.4.9", "0.5.0")).toBe(true);
    expect(shouldSuppressUpdate("automatic", "0.5.1", "0.5.0")).toBe(false);
    expect(shouldSuppressUpdate("automatic", "0.5.0", null)).toBe(false);
  });

  it("手动检查始终显示 updater 返回的更新", () => {
    expect(shouldSuppressUpdate("manual", "0.5.0", "0.5.0")).toBe(false);
    expect(shouldSuppressUpdate("manual", "0.4.9", "0.5.0")).toBe(false);
  });

  it("异常版本仅按规范化后的完整文本匹配", () => {
    expect(compareReleaseVersions("preview", "preview")).toBeNull();
    expect(shouldSuppressUpdate("automatic", "vpreview", "preview")).toBe(true);
    expect(shouldSuppressUpdate("automatic", "preview-2", "preview")).toBe(false);
  });
});
