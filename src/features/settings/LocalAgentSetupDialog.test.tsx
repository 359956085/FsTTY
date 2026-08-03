// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgentCapability,
  LocalAgentConfigureResult,
} from "../../shared/api/types";
import { LocalAgentSetupDialog } from "./LocalAgentSetupDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
});
