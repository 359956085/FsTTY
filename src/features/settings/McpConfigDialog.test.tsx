// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpConfigDialogState } from "./McpConfigDialog";
import { McpConfigDialog } from "./McpConfigDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const dialog: McpConfigDialogState = {
  config: "{\"mcpServers\":{}}",
  error: null,
  loading: false,
  target: "codex",
  transport: "stdio",
};

afterEach(cleanup);

describe("McpConfigDialog", () => {
  it("复制按钮触发统一复制流程", () => {
    const onCopy = vi.fn();

    render(
      <McpConfigDialog
        dialog={dialog}
        onClose={vi.fn()}
        onCopy={onCopy}
        onTargetChange={vi.fn()}
        options={[{ value: "codex", label: "Codex" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.mcpCopyConfig" }));

    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("Escape 关闭弹窗，卸载后移除监听", () => {
    const onClose = vi.fn();
    const rendered = render(
      <McpConfigDialog
        dialog={dialog}
        onClose={onClose}
        onCopy={vi.fn()}
        onTargetChange={vi.fn()}
        options={[{ value: "codex", label: "Codex" }]}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rendered.unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
