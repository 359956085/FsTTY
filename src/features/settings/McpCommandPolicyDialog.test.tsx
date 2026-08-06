// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMcpPermission } from "./mcpPermissions";
import { McpCommandPolicyDialog } from "./McpCommandPolicyDialog";

const mocks = vi.hoisted(() => ({
  exportPolicy: vi.fn(),
  importPolicy: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: mocks.save,
}));
vi.mock("../../shared/api/client", () => ({
  api: {
    exportMcpCommandPolicy: mocks.exportPolicy,
    importMcpCommandPolicy: mocks.importPolicy,
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("McpCommandPolicyDialog", () => {
  it("未满足基础权限时仍可编辑并提交精确或模糊规则", () => {
    const onConfirm = vi.fn();
    render(
      <McpCommandPolicyDialog
        groupName="prod"
        onClose={vi.fn()}
        onConfirm={onConfirm}
        permission={defaultMcpPermission("prod")}
      />,
    );

    expect(screen.getByText("settings.mcpCommandPolicyInactive")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpCommandPolicyAdd" }));
    const patternInput = screen.getByLabelText(
      "settings.mcpCommandPolicyPattern",
    ) as HTMLInputElement;
    expect(patternInput.placeholder).toBe(
      "settings.mcpCommandPolicyPatternPlaceholderExact",
    );
    fireEvent.click(screen.getByLabelText("settings.mcpCommandPolicyMatchType"));
    fireEvent.click(screen.getByRole("option", { name: "settings.mcpCommandPolicyGlob" }));
    expect(patternInput.placeholder).toBe(
      "settings.mcpCommandPolicyPatternPlaceholderGlob",
    );
    fireEvent.change(patternInput, {
      target: { value: " git status * " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.mcpCommandPolicyComplete" }),
    );

    expect(onConfirm).toHaveBeenCalledWith({
      enabled: true,
      mode: "allow",
      allowRules: [{ matchType: "glob", pattern: "git status *" }],
      excludeRules: [],
    });
  });

  it("规则倒序显示且新建、编辑和删除映射到原数组", () => {
    const onConfirm = vi.fn();
    const permission = defaultMcpPermission("prod");
    permission.commandPolicy.allowRules = [
      { matchType: "exact", pattern: "first" },
      { matchType: "glob", pattern: "second *" },
    ];
    render(
      <McpCommandPolicyDialog
        groupName="prod"
        onClose={vi.fn()}
        onConfirm={onConfirm}
        permission={permission}
      />,
    );

    expect(
      screen
        .getAllByLabelText("settings.mcpCommandPolicyPattern")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["second *", "first"]);

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpCommandPolicyAdd" }));
    const inputs = screen.getAllByLabelText("settings.mcpCommandPolicyPattern");
    expect(inputs.map((input) => (input as HTMLInputElement).value)).toEqual([
      "",
      "second *",
      "first",
    ]);
    fireEvent.change(inputs[0], { target: { value: "newest" } });
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "settings.mcpCommandPolicyDeleteRule",
      })[1],
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.mcpCommandPolicyComplete" }),
    );

    expect(onConfirm).toHaveBeenCalledWith({
      enabled: false,
      mode: "allow",
      allowRules: [
        { matchType: "exact", pattern: "first" },
        { matchType: "exact", pattern: "newest" },
      ],
      excludeRules: [],
    });
  });

  it("导入完整替换草稿且导出当前草稿", async () => {
    mocks.open.mockResolvedValue("C:\\policy.json");
    mocks.importPolicy.mockResolvedValue({
      enabled: true,
      mode: "exclude",
      allowRules: [{ matchType: "exact", pattern: "pwd" }],
      excludeRules: [
        { matchType: "glob", pattern: "rm *" },
      ],
    });
    mocks.save.mockResolvedValue("C:\\export.json");
    mocks.exportPolicy.mockResolvedValue(undefined);
    render(
      <McpCommandPolicyDialog
        groupName="prod"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        permission={defaultMcpPermission("prod")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpCommandPolicyImport" }));
    await waitFor(() => expect(mocks.importPolicy).toHaveBeenCalledWith("C:\\policy.json"));
    expect(
      screen
        .getAllByLabelText("settings.mcpCommandPolicyPattern")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["rm *"]);
    expect(screen.getByLabelText("settings.mcpCommandPolicyMode").textContent).toContain(
      "settings.mcpCommandPolicyExclude",
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpCommandPolicyExport" }));
    await waitFor(() =>
      expect(mocks.exportPolicy).toHaveBeenCalledWith("C:\\export.json", {
        enabled: true,
        mode: "exclude",
        allowRules: [{ matchType: "exact", pattern: "pwd" }],
        excludeRules: [{ matchType: "glob", pattern: "rm *" }],
      }),
    );
  });

  it("共享下拉框支持键盘选择且 Escape 只关闭菜单", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <McpCommandPolicyDialog
        groupName="prod"
        onClose={onClose}
        onConfirm={onConfirm}
        permission={defaultMcpPermission("prod")}
      />,
    );
    const mode = screen.getByLabelText("settings.mcpCommandPolicyMode");
    fireEvent.keyDown(mode, { key: "ArrowDown" });
    fireEvent.keyDown(mode, { key: "ArrowDown" });
    fireEvent.keyDown(mode, { key: "Enter" });
    expect(mode.textContent).toContain("settings.mcpCommandPolicyExclude");

    fireEvent.click(mode);
    expect(mode.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(mode, { key: "Escape" });
    expect(mode.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.mcpCommandPolicyComplete" }),
    );
    expect(onConfirm).toHaveBeenCalledWith({
      enabled: false,
      mode: "exclude",
      allowRules: [],
      excludeRules: [],
    });
  });

  it("切换名单保留两份草稿且只编辑当前名单", () => {
    const onConfirm = vi.fn();
    const permission = defaultMcpPermission("prod");
    permission.commandPolicy.allowRules = [{ matchType: "exact", pattern: "pwd" }];
    permission.commandPolicy.excludeRules = [{ matchType: "glob", pattern: "rm *" }];
    render(
      <McpCommandPolicyDialog
        groupName="prod"
        onClose={vi.fn()}
        onConfirm={onConfirm}
        permission={permission}
      />,
    );

    const mode = screen.getByLabelText("settings.mcpCommandPolicyMode");
    fireEvent.click(mode);
    fireEvent.click(screen.getByRole("option", { name: "settings.mcpCommandPolicyExclude" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpCommandPolicyAdd" }));
    fireEvent.change(screen.getAllByLabelText("settings.mcpCommandPolicyPattern")[0], {
      target: { value: "shutdown *" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.mcpCommandPolicyComplete" }),
    );

    expect(onConfirm).toHaveBeenCalledWith({
      enabled: false,
      mode: "exclude",
      allowRules: [{ matchType: "exact", pattern: "pwd" }],
      excludeRules: [
        { matchType: "glob", pattern: "rm *" },
        { matchType: "exact", pattern: "shutdown *" },
      ],
    });
  });
});
