// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  isValidRemotePath,
  quoteShellPath,
  splitUtf8,
} from "./terminalProtocol";

describe("终端协议工具", () => {
  it("严格处理路径和 Shell 引号", () => {
    expect(isValidRemotePath("/home/用户")).toBe(true);
    expect(isValidRemotePath("relative")).toBe(false);
    expect(isValidRemotePath("/tmp\nfile")).toBe(false);
    expect(quoteShellPath("/tmp/a'b")).toBe("'/tmp/a'\\''b'");
  });

  it("按 UTF-8 字节切分且不拆 Unicode 字符", () => {
    expect(splitUtf8("a中b", 3)).toEqual(["a", "中", "b"]);
    expect(splitUtf8("", 3)).toEqual([]);
  });

  it("解码终端 Base64 数据", () => {
    expect(Array.from(decodeBase64("SGk="))).toEqual([72, 105]);
  });
});
