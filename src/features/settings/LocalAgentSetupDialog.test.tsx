// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgentCapability,
  LocalAgentConfigureResult,
} from "../../shared/api/types";
import { LocalAgentSetupDialog } from "./LocalAgentSetupDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { url?: string }) => options?.url ? `${key}: ${options.url}` : key,
  }),
}));

afterEach(cleanup);

const capabilities: LocalAgentCapability[] = [
  { detail: null, installed: true, state: "missing", target: "codex" },
  { detail: null, installed: true, state: "outdated", target: "geminiCli" },
  {
    detail: "未检测到本地安装",
    installed: false,
    state: "notDetected",
    target: "cursor",
  },
  { detail: null, installed: true, state: "missing", target: "openCode" },
  { detail: null, installed: true, state: "missing", target: "trae" },
  {
    detail: "未检测到本地安装",
    installed: false,
    state: "notDetected",
    target: "traeCn",
  },
];

function renderDialog(
  onConfigure = vi.fn(),
  results: LocalAgentConfigureResult[] = [],
) {
  render(
    <LocalAgentSetupDialog
      capabilities={capabilities}
      configuring={false}
      error={null}
      loading={false}
      onClose={vi.fn()}
      onConfigure={onConfigure}
      open
      results={results}
    />,
  );
  return onConfigure;
}

describe("LocalAgentSetupDialog", () => {
  it("默认选择已安装 Agent 并禁用未安装项", () => {
    const onConfigure = renderDialog();

    expect((screen.getByRole("checkbox", { name: /Codex/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByRole("checkbox", { name: /Gemini CLI/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Cursor/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: /OpenCode/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByRole("checkbox", { name: /^Traesettings/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Trae CN/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentConfigure" }));

    expect(onConfigure).toHaveBeenCalledWith(["codex", "geminiCli", "openCode", "trae"]);
  });

  it("允许取消选择并展示部分失败结果", () => {
    const onConfigure = renderDialog(vi.fn(), [
      {
        mcpStatus: "configured",
        promptStatus: "configured",
        message: null,
        target: "openCode",
      },
      {
        mcpStatus: "failed",
        promptStatus: "failed",
        message: "配置损坏",
        target: "geminiCli",
      },
    ]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Gemini CLI/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentConfigure" }));

    expect(onConfigure).toHaveBeenCalledWith(["codex", "openCode", "trae"]);
    expect(screen.getByText("settings.localAgentConfigured")).not.toBeNull();
    expect(screen.getByText("settings.localAgentFailed")).not.toBeNull();
    expect(screen.getByText("配置损坏")).not.toBeNull();
  });

  it("HTTP 显示本地地址、凭据和监听范围说明，成功后提醒重载", () => {
    const onConfigure = vi.fn();
    render(
      <LocalAgentSetupDialog
        capabilities={capabilities}
        configuring={false}
        error={null}
        httpPort={42_123}
        loading={false}
        onClose={vi.fn()}
        onConfigure={onConfigure}
        open
        results={[{ target: "codex", mcpStatus: "configured", promptStatus: "configured", message: null }]}
        transport="http"
      />,
    );
    expect(screen.getByRole("dialog", { name: "settings.localAgentHttpTitle" })).not.toBeNull();
    expect(screen.getByText("settings.localAgentHttpHint")).not.toBeNull();
    expect(screen.getByText("settings.localAgentHttpAddress: http://127.0.0.1:42123/mcp")).not.toBeNull();
    expect(screen.getByText("settings.localAgentHttpSecretHint")).not.toBeNull();
    expect(screen.getByText("settings.localAgentHttpRuntimeHint")).not.toBeNull();
    expect(screen.getByText("settings.localAgentHttpNetworkHint")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("settings.localAgentHttpCompletedHint");
    fireEvent.click(screen.getByRole("button", { name: "settings.localAgentConfigure" }));
    expect(onConfigure).toHaveBeenCalledWith(["codex", "geminiCli", "openCode", "trae"]);
  });

  it("配置期间禁用选择和按钮，Escape 不能关闭弹窗", () => {
    const onClose = vi.fn();
    const onConfigure = vi.fn();
    render(
      <LocalAgentSetupDialog
        capabilities={capabilities}
        configuring
        error={null}
        loading={false}
        onClose={onClose}
        onConfigure={onConfigure}
        open
        results={[]}
        transport="http"
      />,
    );
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
    const configure = screen.getByRole("button", { name: "settings.localAgentConfiguring" }) as HTMLButtonElement;
    fireEvent.click(configure);
    expect(configure.disabled).toBe(true);
    for (const button of screen.getAllByRole("button", { name: "sessions.close" })) fireEvent.click(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
  });
});
