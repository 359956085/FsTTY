// @vitest-environment jsdom

import { createRef, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipButton } from "./TooltipButton";

let focusVisible = false;

function advanceTimers(milliseconds = 250) {
  act(() => { vi.advanceTimersByTime(milliseconds); });
}

beforeEach(() => {
  focusVisible = false;
  vi.useFakeTimers();
  // 模拟浏览器对键盘焦点的判断，避免依赖 jsdom 的焦点启发式。
  vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: HTMLElement, selector) {
    return selector === ":focus-visible" ? focusVisible : Element.prototype.matches.call(this, selector);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("按钮提示", () => {
  it("悬停满 250 毫秒展示，移出立即关闭", () => {
    render(<TooltipButton label="设置" />);
    const button = screen.getByRole("button", { name: "设置" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers(249);
    expect(screen.queryByRole("tooltip")).toBeNull();
    advanceTimers(1);
    expect(screen.getByRole("tooltip").textContent).toBe("设置");
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("提前移出取消计时，重新移入重新等待", () => {
    render(<TooltipButton label="展开文件与设备" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers(200);
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    advanceTimers(500);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers(249);
    expect(screen.queryByRole("tooltip")).toBeNull();
    advanceTimers(1);
    expect(screen.getByRole("tooltip")).not.toBeNull();
  });

  it("鼠标或程序恢复的普通焦点不打开提示，也不阻止移出关闭", () => {
    render(<TooltipButton label="设置" />);
    const button = screen.getByRole("button");
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers();
    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("键盘聚焦立即打开提示，移出光标不影响键盘提示，失焦关闭", () => {
    focusVisible = true;
    render(<TooltipButton label="设置" />);
    const button = screen.getByRole("button");
    fireEvent.keyDown(window, { key: "Tab" });
    act(() => button.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("设置");
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).not.toBeNull();
    act(() => button.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("点击不接收焦点的空白区域仍关闭提示，并使用捕获阶段", () => {
    focusVisible = true;
    render(<>
      <TooltipButton label="设置" />
      <div data-testid="顶部空白" onPointerDown={(event) => event.stopPropagation()} />
    </>);
    const button = screen.getByRole("button");
    act(() => button.focus());
    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId("顶部空白"), { pointerType: "mouse" });
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers();
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("点击其他提示按钮同时清除已显示提示与待展示计时", () => {
    render(<>
      <TooltipButton label="设置" />
      <TooltipButton label="收起文件与设备" />
    </>);
    const settings = screen.getByRole("button", { name: "设置" });
    const collapse = screen.getByRole("button", { name: "收起文件与设备" });
    fireEvent.pointerEnter(settings, { pointerType: "mouse" });
    advanceTimers();
    fireEvent.pointerEnter(collapse, { pointerType: "mouse" });
    fireEvent.pointerDown(collapse, { pointerType: "mouse" });
    advanceTimers(500);
    expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
  });

  it("触屏进入、点击和普通聚焦不显示提示", () => {
    render(<TooltipButton label="设置" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "touch" });
    advanceTimers(500);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => button.focus());
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([
    ["Esc", () => fireEvent.keyDown(window, { key: "Escape" })],
    ["页面滚动", () => fireEvent.scroll(document.body)],
    ["窗口缩放", () => fireEvent.resize(window)],
    ["窗口失焦", () => fireEvent.blur(window)],
    ["空白点击", () => fireEvent.pointerDown(document.body, { pointerType: "mouse" })],
  ])("%s 关闭提示并取消待展示计时", (_name, dismiss) => {
    render(<TooltipButton label="设置" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers();
    expect(screen.getByRole("tooltip")).not.toBeNull();
    dismiss();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    dismiss();
    advanceTimers(500);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("点击关闭提示且继续调用外部事件回调", () => {
    const callbacks = {
      onPointerEnter: vi.fn(), onPointerLeave: vi.fn(),
      onFocus: vi.fn(), onBlur: vi.fn(), onClick: vi.fn(),
    };
    render(<TooltipButton label="设置" {...callbacks} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers();
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => button.focus());
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    act(() => button.blur());
    for (const callback of Object.values(callbacks)) expect(callback).toHaveBeenCalledOnce();
  });

  it("保留外部引用和描述关系，提示通过门户渲染", () => {
    const buttonRef = createRef<HTMLButtonElement>();
    const { container } = render(<TooltipButton label="设置" buttonRef={buttonRef} aria-describedby="其他描述" />);
    const button = screen.getByRole("button");
    expect(buttonRef.current).toBe(button);
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    advanceTimers();
    const tooltip = screen.getByRole("tooltip");
    expect(container.contains(tooltip)).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBe(`其他描述 ${tooltip.id}`);
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(button.getAttribute("aria-describedby")).toBe("其他描述");
  });

  it("失焦取消待展示计时", () => {
    render(<TooltipButton label="设置" />);
    const button = screen.getByRole("button");
    act(() => button.focus());
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    act(() => button.blur());
    advanceTimers(500);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("卸载清理计时和全局捕获监听", () => {
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<TooltipButton label="设置" />);
    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "mouse" });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    advanceTimers(500);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("严格模式不遗留重复监听或计时", () => {
    const { unmount } = render(<StrictMode><TooltipButton label="设置" /></StrictMode>);
    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "mouse" });
    expect(vi.getTimerCount()).toBe(1);
    advanceTimers();
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
