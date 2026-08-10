import { describe, expect, it } from "vitest";
import type { McpGroupPermission, SessionGroup } from "../../shared/api/types";
import {
  MCP_PERMISSION_FIELDS,
  defaultMcpPermission,
  permissionFrom,
  permissionsChanged,
  validateMcpCommandPolicy,
  validateMcpPort,
} from "./mcpPermissions";

const groups: SessionGroup[] = [{ name: "生产", sessions: [] }];

describe("MCP 权限表单纯函数", () => {
  it("按访问、读取、传输、编辑、删除、命令排列", () => {
    expect(MCP_PERMISSION_FIELDS).toEqual([
      "enabled",
      "fileRead",
      "fileTransfer",
      "fileWrite",
      "fileDelete",
      "commandExecute",
    ]);
  });

  it("为新分组提供安全默认值", () => {
    expect(defaultMcpPermission("生产")).toEqual({
      groupName: "生产",
      enabled: false,
      sessionRead: true,
      fileRead: true,
      fileTransfer: false,
      commandExecute: false,
      fileWrite: false,
      fileDelete: false,
      commandPolicy: { enabled: false, mode: "allow", allowRules: [], excludeRules: [] },
    });
  });

  it("只在有效权限字段变化时标记草稿", () => {
    const saved: McpGroupPermission[] = [defaultMcpPermission("生产")];
    expect(permissionsChanged(groups, saved, saved)).toBe(false);
    expect(
      permissionsChanged(groups, [{ ...saved[0], fileTransfer: true }], saved),
    ).toBe(true);
    expect(permissionFrom([], "生产")).toEqual(saved[0]);
    expect(
      permissionsChanged(
        groups,
        [
          {
            ...saved[0],
            commandPolicy: { enabled: true, mode: "allow", allowRules: [], excludeRules: [] },
          },
        ],
        saved,
      ),
    ).toBe(true);
  });

  it("验证高级命令规则的空值、重复和控制字符", () => {
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "allow",
        allowRules: [{ matchType: "exact", pattern: "" }],
        excludeRules: [],
      }),
    ).toBe("empty");
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "allow",
        allowRules: [
          { matchType: "glob", pattern: "git *" },
          { matchType: "glob", pattern: " git * " },
        ],
        excludeRules: [],
      }),
    ).toBe("duplicate");
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "exclude",
        allowRules: [],
        excludeRules: [{ matchType: "exact", pattern: "echo\nsecret" }],
      }),
    ).toBe("invalid");
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "allow",
        allowRules: [{ matchType: "exact", pattern: "pwd" }],
        excludeRules: [{ matchType: "exact", pattern: "pwd" }],
      }),
    ).toBeNull();
    expect(
      validateMcpCommandPolicy({
        enabled: true,
        mode: "allow",
        allowRules: Array.from({ length: 1001 }, (_, index) => ({
          matchType: "exact" as const,
          pattern: `command-${index}`,
        })),
        excludeRules: [],
      }),
    ).toBe("tooMany");
  });

  it("验证 HTTP 端口边界", () => {
    expect(validateMcpPort("1")).toBe(1);
    expect(validateMcpPort("65535")).toBe(65_535);
    expect(validateMcpPort("0")).toBeNull();
    expect(validateMcpPort("1.5")).toBeNull();
  });
});
