import { describe, expect, it } from "vitest";
import type { McpGroupPermission, SessionGroup } from "../../shared/api/types";
import {
  defaultMcpPermission,
  permissionFrom,
  permissionsChanged,
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
    });
  });

  it("只在有效权限字段变化时标记草稿", () => {
    const saved: McpGroupPermission[] = [defaultMcpPermission("生产")];
    expect(permissionsChanged(groups, saved, saved)).toBe(false);
    expect(
      permissionsChanged(groups, [{ ...saved[0], fileWrite: true }], saved),
    ).toBe(true);
    expect(permissionFrom([], "生产")).toEqual(saved[0]);
  });

  it("验证 HTTP 端口边界", () => {
    expect(validateMcpPort("1")).toBe(1);
    expect(validateMcpPort("65535")).toBe(65_535);
    expect(validateMcpPort("0")).toBeNull();
    expect(validateMcpPort("1.5")).toBeNull();
  });
});
