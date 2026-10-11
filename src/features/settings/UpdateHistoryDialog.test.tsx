// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
import { UpdateHistoryDialog as UpdateHistoryDialogContent } from "./UpdateHistoryDialog";

function UpdateHistoryDialog(props: Omit<ComponentProps<typeof UpdateHistoryDialogContent>, "dialogRef">) {
  const { dialogRef, requestClose } = useDialogFocus({ open: props.open, onClose: props.onClose });
  return <UpdateHistoryDialogContent {...props} dialogRef={dialogRef} onClose={requestClose} />;
}

const locale = vi.hoisted(() => ({ value: "zh-CN" }));
vi.mock("../../../CHANGELOG.md?raw", async () => ({
  default: (await import("./testFixtures/update-history.md?raw")).default,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: locale.value, resolvedLanguage: locale.value },
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  locale.value = "zh-CN";
});

describe("更新日志弹窗", () => {
  it.each([
    { language: "zh-CN", feature: "中文功能", emphasis: "重点", paragraph: "中文段落说明。", excluded: "English paragraph." },
    { language: "en-US", feature: "English feature", emphasis: "highlight", paragraph: "English paragraph.", excluded: "中文段落说明。" },
  ])("$language 渲染对应语言、日期和 Markdown，不依赖真实发布文案", ({ language, feature, emphasis, paragraph, excluded }) => {
    locale.value = language;
    render(<UpdateHistoryDialog onClose={vi.fn()} open />);
    const article = screen.getByRole("heading", { level: 3, name: "v8.3.0" }).closest("article")!;
    const content = within(article);
    expect(content.getByText(feature, { exact: false })).toBeTruthy();
    expect(content.getByText(emphasis).tagName).toBe("STRONG");
    expect(content.getByText(paragraph)).toBeTruthy();
    expect(content.getByText("2026-08-03").getAttribute("dateTime")).toBe("2026-08-03");
    expect(screen.queryByText(excluded)).toBeNull();
    expect(screen.queryByText("未发布内容 / Unreleased content")).toBeNull();
    expect(article.textContent).not.toContain("release-notes:");
  });

  it("正式版优先，同版本 beta 按数值排序，保留历史且不串版本", () => {
    render(<UpdateHistoryDialog onClose={vi.fn()} open />);
    expect(screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent))
      .toEqual(["v8.3.0", "v8.3.0-beta.10", "v8.3.0-beta.2", "v8.2.0"]);
    const latest = screen.getByRole("heading", { name: "v8.3.0" }).closest("article")!;
    expect(latest.textContent).not.toContain("历史中文说明");
    expect(latest.textContent).not.toContain("最新测试版");
    expect(screen.getByText("历史中文说明")).toBeTruthy();
  });

  it("语言切换刷新内容，不关闭弹窗或重置键盘焦点", () => {
    const onClose = vi.fn();
    const view = render(<UpdateHistoryDialog onClose={onClose} open />);
    const close = screen.getAllByRole("button", { name: "sessions.close" })[0];
    close.focus();
    locale.value = "en-US";
    view.rerender(<UpdateHistoryDialog onClose={onClose} open />);
    expect(screen.getByText("English paragraph.")).toBeTruthy();
    expect(screen.queryByText("中文段落说明。")).toBeNull();
    expect(document.activeElement).toBe(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["Escape", "backdrop", "top close", "footer close"])("%s 请求关闭", method => {
    const onClose = vi.fn();
    render(<UpdateHistoryDialog onClose={onClose} open />);
    if (method === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (method === "backdrop") fireEvent.mouseDown(document.querySelector(".dialog-backdrop")!);
    else fireEvent.click(screen.getAllByRole("button", { name: "sessions.close" })[method === "top close" ? 0 : 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("内容点击不关闭，关闭状态不渲染弹窗", () => {
    const onClose = vi.fn();
    const view = render(<UpdateHistoryDialog onClose={onClose} open />);
    fireEvent.mouseDown(screen.getByRole("heading", { name: "v8.3.0" }));
    expect(onClose).not.toHaveBeenCalled();
    view.rerender(<UpdateHistoryDialog onClose={onClose} open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
