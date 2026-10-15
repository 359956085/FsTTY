import { describe, expect, it } from "vitest";
import { createLocalHistoryInsertion, parseLocalHistoryNotification } from "./localCommandHistory";

describe("local global command history", () => {
  it("uses verified whole-line bindings without Enter; unsupported editors copy", () => {
    expect(createLocalHistoryInsertion("echo 中文 & 'a'", "clear")).toBe("\x1b[24;7~echo 中文 & 'a'");
    expect(createLocalHistoryInsertion("echo 中文", "clear")).toBe("\x1b[24;7~echo 中文");
    expect(createLocalHistoryInsertion("echo x", "copy")).toBeNull();
    for (const command of ["a\nb", "a\rb", "a\tb", "\x1b[31m", " ", "a".repeat(65537)]) expect(createLocalHistoryInsertion(command, "clear")).toBeNull();
  });
  it("does not record commands in the webview; rejects stale capabilities and warnings", () => {
    expect(parseLocalHistoryNotification("fstty-global:old:input:clear", "current")).toBeNull();
    expect(parseLocalHistoryNotification("fstty-global:current:input:clear", null)).toBeNull();
    expect(parseLocalHistoryNotification("fstty-global:current:command:1:ZWNobw==", "current")).toBeNull();
    expect(parseLocalHistoryNotification("fstty-global:current:input:clear", "current")).toEqual({ kind: "input", binding: "clear" });
    expect(parseLocalHistoryNotification("fstty-global:current:input:unknown", "current")).toEqual({ kind: "input", binding: "copy" });
    expect(parseLocalHistoryNotification("fstty-global:current:execute", "current")).toEqual({ kind: "execute" });
    expect(parseLocalHistoryNotification("fstty-global:current:write-failed", "current")).toEqual({ kind: "warning", value: "write-failed" });
  });
});
