import { describe, expect, it } from "vitest";
import { resolveUpdaterPublicKey } from "./ci-build-config.mjs";

describe("CI 更新公钥配置", () => {
  it("无签名验证可直接使用仓库公钥", () => {
    expect(resolveUpdaterPublicKey("repository-key", undefined, false)).toBe("repository-key");
  });

  it("提供 Actions 公钥时必须与仓库一致", () => {
    expect(resolveUpdaterPublicKey("same-key", " same-key ", false)).toBe("same-key");
    expect(() => resolveUpdaterPublicKey("repository-key", "other-key", false)).toThrow("不一致");
  });

  it("正式发布仍强制要求 Actions 公钥", () => {
    expect(() => resolveUpdaterPublicKey("repository-key", "", true)).toThrow("正式发布缺少");
    expect(resolveUpdaterPublicKey("repository-key", "repository-key", true)).toBe("repository-key");
  });

  it.each([
    ["", undefined, false],
    ["repository-key", "line-one\nline-two", false],
  ])("拒绝缺失或多行公钥：%j", (configured, provided, required) => {
    expect(() => resolveUpdaterPublicKey(configured, provided, required)).toThrow("公钥");
  });
});
