// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsIconAction } from "./SettingsIconAction";

afterEach(cleanup);

describe("SettingsIconAction", () => {
  it("鼠标和键盘使用同一提示入口", () => {
    const onShowTooltip = vi.fn();
    const onHideTooltip = vi.fn();
    render(
      <SettingsIconAction
        activeTooltipKey={null}
        label="复制配置"
        onActivate={vi.fn()}
        onHideTooltip={onHideTooltip}
        onShowTooltip={onShowTooltip}
        tooltipKey="copy"
      >
        图标
      </SettingsIconAction>,
    );
    const button = screen.getByRole("button", { name: "复制配置" });

    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    fireEvent.blur(button);

    expect(onShowTooltip).toHaveBeenCalledTimes(2);
    expect(onHideTooltip).toHaveBeenCalledOnce();
  });

  it("激活提示时连接 aria-describedby", () => {
    render(
      <SettingsIconAction
        activeTooltipKey="copy"
        label="复制配置"
        onActivate={vi.fn()}
        onHideTooltip={vi.fn()}
        onShowTooltip={vi.fn()}
        tooltipKey="copy"
      >
        图标
      </SettingsIconAction>,
    );

    expect(
      screen.getByRole("button", { name: "复制配置" }).getAttribute("aria-describedby"),
    ).toBe("mcp-permission-tooltip");
  });

  it("点击时返回当前按钮元素", () => {
    const onActivate = vi.fn();
    render(
      <SettingsIconAction
        activeTooltipKey={null}
        label="复制配置"
        onActivate={onActivate}
        onHideTooltip={vi.fn()}
        onShowTooltip={vi.fn()}
        tooltipKey="copy"
      >
        图标
      </SettingsIconAction>,
    );
    const button = screen.getByRole("button", { name: "复制配置" });

    fireEvent.click(button);

    expect(onActivate).toHaveBeenCalledWith(button);
  });
});
