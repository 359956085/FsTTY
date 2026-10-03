// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionGroup } from "../../shared/api/types";
import type { SessionListMutationResult } from "./useSessionsPageState";
import { SessionList } from "./SessionList";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const group = (name: string): SessionGroup => ({ name, sessions: [{ id: name, name: `Session-${name}`, group: name, host: "focus.invalid", port: 22,
  username: "", tags: [], auth: { kind: "password" }, credentialState: "missing", loginSavePrompted: false }] });
const button = (name: string) => screen.getByRole("button", { name: `${name}1` });
const list = () => screen.getByRole("group", { name: "sessions.title" });
const key = (value: string, extra = {}) => fireEvent.keyDown(document.activeElement!, { key: value, ...extra });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(overrides: Partial<ComponentProps<typeof SessionList>> = {}) {
  let props: ComponentProps<typeof SessionList> = {
    groups: ["A", "B", "C", "D"].map(group), query: "", filter: "all", favoriteSessionIds: [], collapsedGroupNames: [], mutationPending: false,
    onQueryChange: vi.fn(), onFilterChange: vi.fn(), onOpen: vi.fn(), onToggleFavorite: vi.fn(), onToggleGroup: vi.fn(), onCreate: vi.fn(),
    onEdit: vi.fn(), onDelete: vi.fn(), onDeleteGroup: vi.fn().mockResolvedValue({ ok: true, value: [] }), onRefresh: vi.fn(),
    onRenameGroup: vi.fn().mockResolvedValue({ ok: true, value: undefined }), onReorderGroup: vi.fn().mockResolvedValue(true), onReorderSession: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const content = () => <StrictMode><SessionList {...props} /></StrictMode>;
  const view = render(content());
  return { ...view, update: (next: Partial<typeof props>) => { props = { ...props, ...next }; view.rerender(content()); } };
}
function open(kind: "rename" | "delete") {
  act(() => button("B").focus()); key("ContextMenu");
  fireEvent.click(screen.getByRole("menuitem", { name: `sessions.${kind}Group` }));
  return screen.getByRole("dialog", { name: `sessions.${kind}Group` });
}

describe("会话与分组键盘体验", () => {
  it("会话支持 Shift+F10，编辑使用会话行作为返回焦点目标", () => {
    const edit = vi.fn(); setup({ onEdit: edit });
    const session = screen.getByRole("button", { name: "Session-Bfocus.invalid" });
    act(() => session.focus()); key("F10", { shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "sessions.contextConnect" }));
    key("Escape"); expect(document.activeElement).toBe(session);
    key("ContextMenu"); fireEvent.click(screen.getByRole("menuitem", { name: "sessions.edit" }));
    expect(edit).toHaveBeenCalledExactlyOnceWith("B", session);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["rename", "delete"] as const)("分组 %s 首次焦点、双向 Tab 和 Esc 返回", (kind) => {
    setup();
    const dialog = open(kind);
    const first = kind === "rename" ? within(dialog).getByRole("textbox") : within(dialog).getByRole("button", { name: "sessions.cancel" });
    const last = within(dialog).getByRole("button", { name: kind === "rename" ? "sessions.save" : "sessions.deleteGroup" });
    expect(document.activeElement).toBe(first);
    key("Tab", { shiftKey: true }); expect(document.activeElement).toBe(last);
    key("Tab"); expect(document.activeElement).toBe(first);
    fireEvent.click(dialog.parentElement!); expect(screen.getByRole("dialog")).toBe(dialog);
    key("Escape", { isComposing: true }); expect(screen.getByRole("dialog")).toBe(dialog);
    key("Escape"); expect(document.activeElement).toBe(button("B"));
    key("ContextMenu"); expect(screen.getByRole("menu")).not.toBeNull();
  });

  it("输入法不提交，保存失败保留草稿，忙碌期间禁止取消与重复提交，重试后定位新组名", async () => {
    const pending = deferred<SessionListMutationResult>();
    const rename = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true });
    const view = setup({ onRenameGroup: rename });
    const dialog = open("rename");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "新分组" } });
    key("Enter", { isComposing: true }); key("Enter", { keyCode: 229 });
    expect(rename).not.toHaveBeenCalled();
    key("Enter"); key("Enter"); key("Escape");
    fireEvent.click(within(dialog).getByRole("button", { name: "sessions.cancel" }));
    expect(rename).toHaveBeenCalledExactlyOnceWith("B", "新分组");
    expect(screen.getByRole("dialog")).toBe(dialog);
    await act(async () => pending.resolve({ ok: false, error: "分组已存在" }));
    expect((input as HTMLInputElement).value).toBe("新分组");
    expect(within(dialog).getByRole("alert").textContent).toBe("分组已存在");
    expect(document.activeElement).toBe(input);
    view.update({ groups: ["A", "新分组", "C"].map(group) });
    await act(async () => { key("Enter"); });
    expect(document.activeElement).toBe(button("新分组"));
  });

  it.each([
    { remaining: ["A", "D"], expected: "D" },
    { remaining: ["A"], expected: "A" },
    { remaining: [], expected: null },
  ])("删除分组成功后按原显示顺序选择 $expected", async ({ remaining, expected }) => {
    const pending = deferred<SessionListMutationResult<string[]>>();
    const view = setup({ onDeleteGroup: () => pending.promise });
    const dialog = open("delete");
    fireEvent.click(within(dialog).getByRole("button", { name: "sessions.deleteGroup" }));
    view.update({ groups: remaining.map(group) });
    await act(async () => pending.resolve({ ok: true, value: ["B"] }));
    expect(document.activeElement).toBe(expected ? button(expected) : list());
  });

  it("入口消失时取消返回列表，更新回调不重置编辑焦点", () => {
    const view = setup();
    const dialog = open("rename");
    const cancel = within(dialog).getByRole("button", { name: "sessions.cancel" });
    act(() => cancel.focus());
    view.update({ groups: [], onRenameGroup: vi.fn() });
    expect(document.activeElement).toBe(cancel);
    key("Escape"); expect(document.activeElement).toBe(list());
  });

  it("筛选切换使旧操作失效，晚到结果不再重开弹窗或恢复焦点", async () => {
    const pending = deferred<SessionListMutationResult>();
    const view = setup({ onRenameGroup: () => pending.promise });
    const dialog = open("rename");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "late" } });
    key("Enter");
    view.update({ query: "no matches" });
    const search = screen.getByRole("textbox");
    act(() => search.focus());
    await act(async () => pending.resolve({ ok: false, error: "late" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(search);
  });
});
