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
        onSave={vi.fn()}
        onShowTooltip={vi.fn()}
        onUpdate={onUpdate}
        permissions={[defaultMcpPermission("prod")]}
        saveSucceeded={false}
        saving={false}
        tooltipKey={null}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "prod commandExecute" }));

    expect(onUpdate).toHaveBeenCalledWith("prod", { commandExecute: true });
  });
});
