// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from "react";
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../shared/api/types";
import { FilesPane } from "./FilesPane";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()) }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onScaleChanged: vi.fn().mockResolvedValue(vi.fn()), scaleFactor: vi.fn().mockResolvedValue(1) }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh-CN" }, t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const file = (name: string): FileEntry => ({ name, path: `/test/${name}`, kind: "file", owner: "test", group: "test", permissions: "-rw-r--r--" });
const initialFiles = [file("a.txt"), file("b.txt"), file("c.txt"), file("d.txt")];
const row = (name: string) => screen.getByRole("button", { name });
const list = () => screen.getByRole("group", { name: "sessions.files" });
const key = (value: string, extra = {}) => fireEvent.keyDown(document.activeElement!, { key: value, ...extra });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(overrides: Partial<ComponentProps<typeof FilesPane>> = {}) {
  let props: ComponentProps<typeof FilesPane> = {
    connectionId: "connection-a", currentPath: "/test", files: initialFiles, loading: false, sftpAvailable: true, transfer: null,
    onCancelTransfer: vi.fn(), onDismissTransfer: vi.fn(), onCollapse: vi.fn(), onCreateDirectory: vi.fn().mockResolvedValue(undefined),
    onDeleteEntry: vi.fn().mockResolvedValue(undefined), onDeleteEntries: vi.fn().mockResolvedValue([]), onDownload: vi.fn(), onDownloadFiles: vi.fn(),
    onMoveEntry: vi.fn().mockResolvedValue(undefined), onOpenPath: vi.fn(), onRefresh: vi.fn(), onRenameEntry: vi.fn().mockResolvedValue(undefined),
    onUpload: vi.fn(), onUploadFiles: vi.fn(), ...overrides,
  };
  const content = () => <StrictMode><button>外部入口</button><FilesPane {...props} /></StrictMode>;
  const view = render(content());
  return { ...view, update: (next: Partial<typeof props>) => { props = { ...props, ...next }; view.rerender(content()); } };
}
function open(kind: "create" | "rename" | "delete", target = kind === "create" ? list() : row("b.txt")) {
  act(() => target.focus());
  key("F10", { shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: `sessions.${kind === "create" ? "createDirectory" : kind === "rename" ? "renameRemoteEntry" : "deleteRemoteEntry"}` }));
  return screen.getByRole("dialog");
}
function startInline(name = "b.txt") {
  const target = row(name);
  Object.assign(target, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
  const nameCell = within(target).getByText(name);
  fireEvent.click(target);
  for (const timeStamp of [100, 500]) {
    fireEvent.pointerDown(nameCell, { button: 0, isPrimary: true, pointerId: 1 });
    const click = createEvent.click(nameCell, { detail: 1 });
    Object.defineProperty(click, "timeStamp", { value: timeStamp });
    fireEvent(nameCell, click);
  }
  return screen.getByRole("textbox", { name: "sessions.renameRemoteEntry" });
}

describe("文件操作键盘焦点", () => {
  it.each(["create", "rename", "delete"] as const)("%s 首次聚焦、Tab 双向循环及取消返回入口", (kind) => {
    setup();
    const origin = kind === "create" ? list() : row("b.txt");
    const dialog = open(kind, origin);
    const first = kind === "delete" ? within(dialog).getByRole("button", { name: "sessions.cancel" }) : within(dialog).getByRole("textbox");
    const last = within(dialog).getByRole("button", { name: kind === "delete" ? "sessions.deleteRemoteEntry" : "sessions.save" });
    expect(document.activeElement).toBe(first);
    key("Tab", { shiftKey: true }); expect(document.activeElement).toBe(last);
    key("Tab"); expect(document.activeElement).toBe(first);
    fireEvent.click(dialog.parentElement!);
    expect(screen.getByRole("dialog")).toBe(dialog);
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(origin);
    key("ContextMenu");
    expect(screen.getByRole("menu")).not.toBeNull();
  });

  it("菜单键保留多选，Esc 返回发起行", () => {
    setup();
    fireEvent.click(row("b.txt"));
    fireEvent.click(row("c.txt"), { ctrlKey: true });
    act(() => row("b.txt").focus());
    key("ContextMenu");
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    key("Escape");
    expect(document.activeElement).toBe(row("b.txt"));
    expect(row("c.txt").getAttribute("aria-pressed")).toBe("true");
  });

  it("提交中禁止 Esc、取消与重复提交，失败保留草稿和弹窗内焦点", async () => {
    const pending = deferred();
    const rename = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const view = setup({ onRenameEntry: rename });
    const dialog = open("rename");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "新名称.txt" } });
    key("Enter", { isComposing: true }); key("Enter", { keyCode: 229 }); key("Escape", { isComposing: true });
    expect(rename).not.toHaveBeenCalled();
    key("Enter"); key("Enter"); key("Escape");
    fireEvent.click(within(dialog).getByText("sessions.cancel"));
    expect(rename).toHaveBeenCalledExactlyOnceWith("/test/b.txt", "新名称.txt");
    expect(screen.getByRole("dialog")).toBe(dialog);
    await act(async () => pending.reject(new Error("permission denied")));
    expect((input as HTMLInputElement).value).toBe("新名称.txt");
    expect(within(dialog).getByRole("alert").textContent).toContain("permission denied");
    expect(document.activeElement).toBe(input);
    view.update({ files: [file("a.txt"), file("新名称.txt"), file("c.txt")] });
    await act(async () => { key("Enter"); });
    expect(document.activeElement).toBe(row("新名称.txt"));
    expect(row("新名称.txt").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["create", "rename"] as const)("%s 等待刷新提交后定位结果条目", async (kind) => {
    const pending = deferred();
    const view = setup({ [kind === "create" ? "onCreateDirectory" : "onRenameEntry"]: () => pending.promise });
    const dialog = open(kind);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "结果" } });
    key("Enter");
    view.update({ loading: true, files: [] });
    expect(screen.getByRole("dialog")).toBe(dialog);
    view.update({ loading: false, files: [file("a.txt"), file("结果"), file("c.txt")] });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => pending.resolve());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row("结果"));
    expect(row("结果").getAttribute("aria-pressed")).toBe("true");
    expect(row("a.txt").getAttribute("aria-pressed")).toBe("false");
  });

  it.each([
    { remaining: ["a.txt", "d.txt"], expected: "d.txt" },
    { remaining: ["a.txt"], expected: "a.txt" },
    { remaining: [], expected: null },
  ])("删除后按操作前顺序定位相邻项：$expected", async ({ remaining, expected }) => {
    const pending = deferred();
    const view = setup({ onDeleteEntry: () => pending.promise });
    const dialog = open("delete");
    fireEvent.click(within(dialog).getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    view.update({ files: remaining.map(file) });
    await act(async () => pending.resolve());
    expect(document.activeElement).toBe(expected ? row(expected) : list());
    if (expected) expect(row(expected).getAttribute("aria-pressed")).toBe("true");
    key("ContextMenu");
    expect(screen.getByRole("menu")).not.toBeNull();
  });

  it("批量部分失败保留失败项和弹窗，重试全部成功才恢复相邻项", async () => {
    const batch = deferred<{ path: string; message: string }[]>();
    const retry = deferred();
    const deleteMany = vi.fn(() => batch.promise);
    const deleteOne = vi.fn(() => retry.promise);
    const view = setup({ onDeleteEntries: deleteMany, onDeleteEntry: deleteOne });
    fireEvent.click(row("b.txt"));
    fireEvent.click(row("c.txt"), { ctrlKey: true });
    const dialog = open("delete");
    fireEvent.click(within(dialog).getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    view.update({ files: [file("a.txt"), file("c.txt"), file("d.txt")] });
    await act(async () => batch.resolve([{ path: "/test/c.txt", message: "locked" }]));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog.textContent).not.toContain("/test/b.txt");
    expect(dialog.textContent).toContain("/test/c.txt");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "sessions.cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    expect(deleteOne).toHaveBeenCalledExactlyOnceWith("/test/c.txt");
    view.update({ files: [file("a.txt"), file("d.txt")] });
    await act(async () => retry.resolve());
    expect(document.activeElement).toBe(row("d.txt"));
    expect(row("d.txt").getAttribute("aria-pressed")).toBe("true");
    expect(deleteMany).toHaveBeenCalledOnce();
  });

  it("取消时入口已删除则回退列表，空列表仍可打开新建菜单", () => {
    const view = setup();
    open("rename");
    view.update({ files: [] });
    key("Escape");
    expect(document.activeElement).toBe(list());
    key("ContextMenu");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "sessions.createDirectory" }));
  });

  it.each(["directory", "connection", "unmount"])("%s 切换隔离迟到结果，旧操作不抢新焦点", async (kind) => {
    const pending = deferred();
    const view = setup({ onRenameEntry: () => pending.promise });
    const dialog = open("rename");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "late.txt" } });
    key("Enter");
    if (kind === "unmount") view.unmount();
    else view.update(kind === "directory" ? { currentPath: "/other", files: [] } : { connectionId: "connection-b" });
    const outside = document.createElement("button");
    document.body.append(outside); outside.focus();
    await act(async () => pending.resolve());
    expect(document.activeElement).toBe(outside);
    expect(screen.queryByRole("dialog")).toBeNull();
    outside.remove();
  });

  it("另一个弹窗接管后不恢复列表焦点", async () => {
    const pending = deferred();
    const view = setup({ onDeleteEntry: () => pending.promise });
    const dialog = open("delete");
    fireEvent.click(within(dialog).getByRole("button", { name: "sessions.deleteRemoteEntry" }));
    const other = document.createElement("section");
    other.setAttribute("role", "dialog"); other.setAttribute("aria-modal", "true");
    const button = document.createElement("button"); other.append(button); document.body.append(other); button.focus();
    view.update({ files: [file("a.txt"), file("c.txt")] });
    await act(async () => pending.resolve());
    expect(document.activeElement).toBe(button);
    other.remove();
  });

  it.each(["click", "hidden"])("等待列表提交时 %s 取消待恢复焦点，即使之后目标重新出现", async (reason) => {
    const pending = deferred();
    const view = setup({ onRenameEntry: () => pending.promise });
    const dialog = open("rename");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "new.txt" } });
    key("Enter");
    const panel = view.container.querySelector<HTMLElement>(".files-panel")!;
    if (reason === "hidden") panel.hidden = true;
    view.update({ loading: true, files: [] });
    await act(async () => pending.resolve());
    const temporary = document.createElement("button");
    if (reason === "click") {
      document.body.append(temporary);
      fireEvent.pointerDown(temporary);
      temporary.focus();
      temporary.remove();
    }
    panel.hidden = false;
    view.update({ loading: false, files: [file("new.txt")] });
    expect(document.activeElement).toBe(document.body);
  });

  it("行内重命名忽略组合 Enter/Esc，键盘取消返回条目", () => {
    const rename = vi.fn(); setup({ onRenameEntry: rename });
    const input = startInline();
    fireEvent.change(input, { target: { value: "中文" } });
    key("Enter", { isComposing: true }); key("Escape", { keyCode: 229 });
    expect(rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    key("Escape");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(row("b.txt"));
  });

  it("行内键盘提交跨刷新完成后定位新名称，且不会重复提交", async () => {
    const pending = deferred();
    const rename = vi.fn(() => pending.promise);
    const view = setup({ onRenameEntry: rename });
    const input = startInline();
    fireEvent.change(input, { target: { value: "中文.txt" } });
    key("Enter"); key("Enter"); key("Escape");
    view.update({ files: [file("a.txt"), file("中文.txt"), file("c.txt")] });
    await act(async () => pending.resolve());
    expect(rename).toHaveBeenCalledExactlyOnceWith("/test/b.txt", "中文.txt");
    expect(document.activeElement).toBe(row("中文.txt"));
    expect(row("中文.txt").getAttribute("aria-pressed")).toBe("true");
  });

  it.each([false, true])("行内失焦提交（失败=%s）尊重用户点击的新焦点", async (fail) => {
    const pending = deferred();
    const view = setup({ onRenameEntry: () => pending.promise });
    const input = startInline();
    fireEvent.change(input, { target: { value: "blur.txt" } });
    const outside = screen.getByText("外部入口");
    fireEvent.pointerDown(outside);
    act(() => outside.focus());
    if (!fail) view.update({ files: [file("a.txt"), file("blur.txt")] });
    await act(async () => { if (fail) pending.reject(new Error("failed")); else pending.resolve(); });
    expect(document.activeElement).toBe(outside);
    if (fail) expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("blur.txt");
    else {
      expect(row("blur.txt").getAttribute("aria-pressed")).toBe("true");
      expect(row("a.txt").getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("行内提交期间改选其他行，成功后保留用户的新选区", async () => {
    const pending = deferred();
    const view = setup({ onRenameEntry: () => pending.promise });
    const input = startInline();
    fireEvent.change(input, { target: { value: "new.txt" } });
    const target = row("a.txt");
    fireEvent.pointerDown(target);
    act(() => target.focus());
    fireEvent.click(target);
    view.update({ files: [file("a.txt"), file("new.txt")] });
    await act(async () => pending.resolve());
    expect(document.activeElement).toBe(target);
    expect(row("a.txt").getAttribute("aria-pressed")).toBe("true");
    expect(row("new.txt").getAttribute("aria-pressed")).toBe("false");
  });
});
