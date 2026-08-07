// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateHistoryDialog } from "./UpdateHistoryDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" },
    t: (key: string) => key,
  }),
}));

afterEach(cleanup);

describe("更新日志弹窗", () => {
  it("展示全部中文正式版本并支持三种关闭方式", () => {
    const onClose = vi.fn();
    render(<UpdateHistoryDialog onClose={onClose} open />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("v1.2.1")).toBeTruthy();
    expect(screen.getByText("修复部分按钮点击无响应的问题。")).toBeTruthy();
    expect(screen.queryByText("Unreleased")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop") as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "sessions.close" })[0]);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
