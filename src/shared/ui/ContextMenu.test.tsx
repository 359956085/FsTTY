// @vitest-environment jsdom
import { StrictMode, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useDialogFocus } from "./useDialogFocus";

afterEach(() => { cleanup(); document.body.replaceChildren(); });
const key = (value: string, extra = {}) => fireEvent.keyDown(document.activeElement!, { key: value, ...extra });
function setup(disabled = false) {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const select = vi.fn();
  const items: ContextMenuItem[] = [
    { id: "disabled", label: "禁用", disabled: true, onSelect: select },
    { id: "first", label: "首项", disabled, onSelect: select },
    { id: "last", label: "末项", disabled, onSelect: select },
  ];
  const close = vi.fn();
  const props = { items, onClose: close, x: 10, y: 10 };
  return { opener, select, close, props, ...render(<StrictMode><ContextMenu {...props} /></StrictMode>) };
}

describe("右键菜单键盘与焦点交接", () => {
  it("首次跳过禁用项，方向键循环，Home/End 到首尾", () => {
    setup();
    const first = screen.getByText("首项").closest("button");
    const last = screen.getByText("末项").closest("button");
    expect(document.activeElement).toBe(first);
    key("ArrowUp"); expect(document.activeElement).toBe(last);
    key("ArrowDown"); expect(document.activeElement).toBe(first);
    key("End"); expect(document.activeElement).toBe(last);
    key("Home"); expect(document.activeElement).toBe(first);
  });

  it.each(["Enter", " "])("%s 激活一次，长按和浏览器默认行为不重复提交", (value) => {
    const test = setup();
    key(value, { repeat: true });
    expect(test.select).not.toHaveBeenCalled();
    expect(key(value)).toBe(false);
    key(value);
    expect(test.select).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledExactlyOnceWith("selection");
    expect(document.activeElement).toBe(test.opener);
  });

  it("全禁用时聚焦容器，启用选项后可用键盘访问", () => {
    const test = setup(true);
    expect(document.activeElement).toBe(screen.getByRole("menu"));
    key("ArrowDown");
    test.rerender(<StrictMode><ContextMenu {...test.props} items={test.props.items.map(item => ({ ...item, disabled: false }))} /></StrictMode>);
    expect(document.activeElement).toBe(screen.getByText("禁用").closest("button"));
  });

  it("普通重渲染保留焦点，当前选项被禁用或删除才修复", () => {
    const test = setup();
    key("End");
    const last = document.activeElement;
    test.rerender(<StrictMode><ContextMenu {...test.props} items={[...test.props.items]} onClose={vi.fn()} /></StrictMode>);
    expect(document.activeElement).toBe(last);
    test.rerender(<StrictMode><ContextMenu {...test.props} items={test.props.items.slice(0, 2)} /></StrictMode>);
    expect(document.activeElement).toBe(screen.getByText("首项").closest("button"));
    test.rerender(<StrictMode><ContextMenu {...test.props} items={test.props.items.map(item => ({ ...item, disabled: true }))} /></StrictMode>);
    expect(document.activeElement).toBe(screen.getByRole("menu"));
  });

  it.each([false, true])("Tab（反向=%s）恢复入口并保留浏览器默认导航", (shiftKey) => {
    const test = setup();
    expect(key("Tab", { shiftKey })).toBe(true);
    expect(document.activeElement).toBe(test.opener);
    expect(test.close).toHaveBeenCalledExactlyOnceWith("tab");
    expect(screen.getAllByRole("menuitem").every(item => item.tabIndex === -1)).toBe(true);
  });

  it("Esc 返回入口，组合输入和已消费事件不会关闭菜单", () => {
    const test = setup();
    key("Escape", { isComposing: true });
    key("Escape", { keyCode: 229 });
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(document.activeElement!, handled);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(test.close).not.toHaveBeenCalled();
    key("Escape");
    expect(test.close).toHaveBeenCalledExactlyOnceWith("escape");
    expect(document.activeElement).toBe(test.opener);
  });

  it("外部点击不恢复入口，由点击目标接管焦点", () => {
    const test = setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    const focus = vi.spyOn(test.opener, "focus");
    fireEvent.mouseDown(outside);
    outside.focus();
    expect(test.close).toHaveBeenCalledExactlyOnceWith("outside");
    expect(document.activeElement).toBe(outside);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["hidden", "removed"])("入口%s时使用有效备用目标", (kind) => {
    const test = setup();
    const fallback = document.createElement("button");
    document.body.append(fallback);
    if (kind === "hidden") test.opener.hidden = true;
    else test.opener.remove();
    test.rerender(<StrictMode><ContextMenu {...test.props} fallbackFocus={() => fallback} /></StrictMode>);
    key("Escape");
    expect(document.activeElement).toBe(fallback);
  });

  it("菜单到弹窗交接不在卸载时抢焦点，关闭后可再次打开", () => {
    function Preview() {
      const opener = useRef<HTMLButtonElement>(null);
      const [menu, setMenu] = useState(false);
      const [dialog, setDialog] = useState(false);
      const { dialogRef } = useDialogFocus({ open: dialog, onClose: () => setDialog(false), returnFocus: () => opener.current });
      return <><button ref={opener} onClick={() => setMenu(true)}>入口</button>
        {menu && <ContextMenu x={0} y={0} returnFocus={() => opener.current} onClose={() => setMenu(false)} items={[{ id: "edit", label: "编辑", onSelect: () => setDialog(true) }]} />}
        {dialog && <section role="dialog" aria-modal="true" tabIndex={-1} ref={dialogRef}><input aria-label="草稿" /></section>}
      </>;
    }
    render(<StrictMode><Preview /></StrictMode>);
    fireEvent.click(screen.getByText("入口"));
    key("Enter");
    expect(document.activeElement).toBe(screen.getByLabelText("草稿"));
    key("Escape");
    expect(document.activeElement).toBe(screen.getByText("入口"));
    fireEvent.click(document.activeElement!);
    expect(document.activeElement).toBe(screen.getByRole("menuitem"));
  });

  it("StrictMode 卸载后不恢复焦点，也不保留全局监听", () => {
    const test = setup();
    const focus = vi.spyOn(test.opener, "focus");
    test.unmount();
    act(() => {
      fireEvent.resize(window);
      fireEvent.scroll(window);
      fireEvent.mouseDown(document.body);
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(test.close).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
