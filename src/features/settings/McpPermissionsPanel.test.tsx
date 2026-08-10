// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMcpPermission } from "./mcpPermissions";
import { McpPermissionsPanel } from "./McpPermissionsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(cleanup);

describe("McpPermissionsPanel", () => {
  it("无修改时禁用保存，修改后允许保存", () => {
    const onSave = vi.fn();
    const common = {
      catalog: [],
      catalogFailed: false,
      error: null,
      groups: [{ name: "prod", sessions: [] }],
      onHideTooltip: vi.fn(),
      onManageCommandPolicy: vi.fn(),
      onSave,
      onShowTooltip: vi.fn(),
      onUpdate: vi.fn(),
      permissions: [defaultMcpPermission("prod")],
      saving: false,
      saveSucceeded: false,
      tooltipKey: null,
    };
    const rendered = render(<McpPermissionsPanel {...common} dirty={false} />);

    expect(
      (screen.getByRole("button", { name: "settings.mcpSave" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    rendered.rerender(<McpPermissionsPanel {...common} dirty />);
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpSave" }));

    expect(onSave).toHaveBeenCalledOnce();
  });

  it("权限复选框只更新对应分组字段", () => {
    const onUpdate = vi.fn();
    render(
      <McpPermissionsPanel
        catalog={[]}
        catalogFailed={false}
        dirty
        error={null}
        groups={[{ name: "prod", sessions: [] }]}
        onHideTooltip={vi.fn()}
        onManageCommandPolicy={vi.fn()}
        onSave={vi.fn()}
        onShowTooltip={vi.fn()}
        onUpdate={onUpdate}
        permissions={[defaultMcpPermission("prod")]}
        saveSucceeded={false}
        saving={false}
        tooltipKey={null}
      />,
    );

    expect(screen.queryByRole("checkbox", { name: "prod sessionRead" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "prod fileTransfer" }));

    expect(onUpdate).toHaveBeenCalledWith("prod", { fileTransfer: true });
  });

  it("命令未勾选时高级管理按钮仍可打开", () => {
    const onManageCommandPolicy = vi.fn();
    const permission = defaultMcpPermission("prod");
    const common = {
      catalog: [],
      catalogFailed: false,
      dirty: false,
      error: null,
      groups: [{ name: "prod", sessions: [] }],
      onHideTooltip: vi.fn(),
      onManageCommandPolicy,
      onSave: vi.fn(),
      onShowTooltip: vi.fn(),
      onUpdate: vi.fn(),
      saveSucceeded: false,
      saving: false,
      tooltipKey: null,
    };
    const rendered = render(
      <McpPermissionsPanel {...common} permissions={[permission]} />,
    );
    const manageButton = screen.getByRole("button", {
      name: "settings.mcpCommandPolicyManageGroup",
    });
    expect(manageButton.classList.contains("settings-mcp-command-policy-open")).toBe(true);
    expect(manageButton.classList.contains("active")).toBe(false);
    const icon = manageButton.querySelector("svg");
    expect(icon?.classList.contains("lucide-settings")).toBe(true);
    expect(icon?.classList.contains("lucide-settings-2")).toBe(false);
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
    fireEvent.click(manageButton);
    expect(onManageCommandPolicy).toHaveBeenCalledWith("prod");

    rendered.rerender(
      <McpPermissionsPanel
        {...common}
        permissions={[
          {
            ...permission,
            commandPolicy: { ...permission.commandPolicy, enabled: true },
          },
        ]}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "settings.mcpCommandPolicyManageGroup" })
        .classList.contains("active"),
    ).toBe(true);
  });
});
