// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

type Options = Parameters<typeof useDialogFocus>[0];
function Harness({ open = true, empty = false, replacement = false, ...options }: Options & { empty?: boolean; replacement?: boolean }) {
  const { dialogRef } = useDialogFocus({ open, ...options });
  return open ? <section role="dialog" aria-modal="true" tabIndex={-1} ref={dialogRef} key={String(replacement)}>
    {!empty && <>
      <button>first</button>
      <button disabled>disabled</button>
      <div hidden><button>hidden</button></div>
      <div style={{ display: "none" }}><button>display none</button></div>
      <div style={{ visibility: "hidden" }}><button>invisible</button></div>
      <div inert><button>inert</button></div>
      <button tabIndex={-1}>excluded</button>
      <button>last</button>
    </>}
  </section> : null;
}

afterEach(() => { cleanup(); document.body.replaceChildren(); });

describe("弹窗焦点生命周期", () => {
  it("跳过禁用和隐藏控件，首尾循环，背景抢焦点时返回弹窗", () => {
    const background = document.createElement("button");
    document.body.append(background);
    render(<Harness onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByText("first"));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
    background.focus();
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("无可聚焦控件时容器承接 Tab，动态内容恢复后可导航", () => {
    const props = { onClose: vi.fn() };
    const { rerender } = render(<Harness {...props} empty />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    rerender(<Harness {...props} />);
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("弹窗内部的隐式或程序焦点不被误判为背景，保留浏览器的 Tab 前进", () => {
    render(<Harness onClose={vi.fn()} />);
    const internal = screen.getByText("excluded");
    internal.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    internal.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(internal);
  });

  it("忙碌及回调更新不重新聚焦，Esc 使用最新回调并尊重已处理和输入法事件", () => {
    const original = vi.fn();
    const next = vi.fn();
    const { rerender } = render(<Harness onClose={original} />);
    screen.getByText("last").focus();
    rerender(<Harness onClose={next} canClose={false} />);
    expect(document.activeElement).toBe(screen.getByText("last"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(next).not.toHaveBeenCalled();
    rerender(<Harness onClose={next} />);
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    fireEvent.keyDown(window, { key: "Escape", keyCode: 229 });
    expect(next).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(next).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });

  it("StrictMode 及容器替换只在真正关闭时恢复入口，不残留键盘监听", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const { rerender, unmount } = render(<StrictMode><Harness onClose={close} /></StrictMode>);
    const focus = vi.spyOn(opener, "focus");
    rerender(<StrictMode><Harness onClose={close} replacement /></StrictMode>);
    expect(document.activeElement).toBe(screen.getByText("first"));
    expect(focus).not.toHaveBeenCalled();
    rerender(<StrictMode><Harness onClose={close} open={false} /></StrictMode>);
    expect(document.activeElement).toBe(opener);
    expect(focus).toHaveBeenCalledOnce();
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["removed", "hidden"])("入口 %s 时使用明确的备用入口", (state) => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(opener, fallback);
    opener.focus();
    const { unmount } = render(<Harness onClose={vi.fn()} returnFocus={() => opener} fallbackFocus={() => fallback} />);
    if (state === "removed") opener.remove(); else opener.hidden = true;
    unmount();
    expect(document.activeElement).toBe(fallback);
  });

  it("入口和备用入口都卸载时不尝试聚焦", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<Harness onClose={vi.fn()} />);
    const focus = vi.spyOn(opener, "focus");
    opener.remove();
    unmount();
    expect(focus).not.toHaveBeenCalled();
  });

  it("其他弹窗接管焦点后不拦截按键或在卸载时抢回焦点", () => {
    const close = vi.fn();
    const { unmount } = render(<Harness onClose={close} />);
    const other = document.createElement("section");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    other.append(button);
    document.body.append(other);
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    unmount();
    expect(document.activeElement).toBe(button);
  });

  it("重复打开捕获新的入口", () => {
    function Owner() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>open</button><Harness open={open} onClose={() => setOpen(false)} /></>;
    }
    render(<Owner />);
    const opener = screen.getByText("open");
    for (let i = 0; i < 2; i += 1) {
      opener.focus();
      fireEvent.click(opener);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(document.activeElement).toBe(opener);
    }
  });
});
