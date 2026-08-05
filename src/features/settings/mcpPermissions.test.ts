import { describe, expect, it } from "vitest";
import type { McpGroupPermission, SessionGroup } from "../../shared/api/types";
import {
  defaultMcpPermission,
  permissionFrom,
  permissionsChanged,
  validateMcpCommandPolicy,
  validateMcpPort,
} from "./mcpPermissions";

const groups: SessionGroup[] = [{ name: "生产", sessions: [] }];

describe("MCP 权限表单纯函数", () => {
  it("为新分组提供安全默认值", () => {
    expect(defaultMcpPermission("生产")).toEqual({
      groupName: "生产",
      enabled: false,
      sessionRead: true,
      fileRead: true,
      commandExecute: false,
      fileWrite: false,
      fileDelete: false,
      commandPolicy: { enabled: false, mode: "allow", rules: [] },
    });
  });

  it("只在有效权限字段变化时标记草稿", () => {
    const saved: McpGroupPermission[] = [defaultMcpPermission("生产")];
    expect(permissionsChanged(groups, saved, saved)).toBe(false);
    expect(
      permissionsChanged(groups, [{ ...saved[0], fileWrite: true }], saved),
    ).toBe(true);
    expect(permissionFrom([], "生产")).toEqual(saved[0]);
    expect(
      permissionsChanged(
        groups,
        [{ ...saved[0], commandPolicy: { enabled: true, mode: "allow", rules: [] } }],
        saved,
      ),
    ).toBe(true);
  });

  it("验证高级命令规则的空值、重复和控制字符", () => {
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "allow",
        rules: [{ matchType: "exact", pattern: "" }],
      }),
    ).toBe("empty");
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "allow",
        rules: [
          { matchType: "glob", pattern: "git *" },
          { matchType: "glob", pattern: " git * " },
        ],
      }),
    ).toBe("duplicate");
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "exclude",
        rules: [{ matchType: "exact", pattern: "echo\nsecret" }],
      }),
    ).toBe("invalid");
  });

  it("验证 HTTP 端口边界", () => {
    expect(validateMcpPort("1")).toBe(1);
    expect(validateMcpPort("65535")).toBe(65_535);
    expect(validateMcpPort("0")).toBeNull();
    expect(validateMcpPort("1.5")).toBeNull();
  });
});
