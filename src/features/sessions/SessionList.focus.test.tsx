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
  it.each(["cmd", "powershell", "gitBash"] as const)("%s 第二行只显示默认权限，配置编辑更新文案，临时打开不改变默认值", (shell) => {
    const onOpen = vi.fn();
    const session = { kind: "local" as const, id: shell, name: "Dev", shell, group: "Local", tags: [], startingDirectory: "C:\\隔离 工作区", runAsAdmin: false };
    const view = setup({ groups: [{ name: "Local", sessions: [session] }], onOpen });
    const metadata = () => screen.getByText("Dev").closest("button")!.querySelector(".session-meta")!.textContent;
    expect(metadata()).toBe("local.standard");
    fireEvent.contextMenu(screen.getByText("Dev")); fireEvent.click(screen.getByRole("menuitem", { name: "local.openAdmin" }));
    expect(onOpen).toHaveBeenLastCalledWith(shell, true, true); expect(metadata()).toBe("local.standard");
    view.update({ groups: [{ name: "Local", sessions: [{ ...session, runAsAdmin: true }] }] });
    expect(metadata()).toBe("local.admin");
    fireEvent.contextMenu(screen.getByText("Dev")); fireEvent.click(screen.getByRole("menuitem", { name: "local.openNormal" }));
    expect(onOpen).toHaveBeenLastCalledWith(shell, true, false); expect(metadata()).toBe("local.admin");
  });
  it.each(["PowerShell", "C:\\隔离 工作区"])("本地列表不展示类型与目录，但仍可搜索 %s", (query) => {
    setup({ query, groups: [{ name: "Local", sessions: [{ kind: "local", id: "local", name: "Dev", shell: "powershell", group: "Local", tags: [],
      startingDirectory: "C:\\隔离 工作区", runAsAdmin: false }] }] });
    expect(screen.getByText("Dev").closest("button")!.querySelector(".session-meta")!.textContent).toBe("local.standard");
    expect(screen.queryByText("sessions.noMatches")).toBeNull();
  });
  it("混合会话使用对应装饰图标，收藏与右键入口仍锚定会话行", () => {
    const favorite = vi.fn(); const onOpen = vi.fn(); const edit = vi.fn();
    const ssh = group("SSH").sessions[0];
    const locals = (["cmd", "powershell", "gitBash"] as const).map(shell => ({
      kind: "local" as const, id: shell, name: `Local-${shell}`, shell, group: "Mixed", tags: [], startingDirectory: "", runAsAdmin: false,
    }));
    const entries = [ssh, ...locals];
    setup({ groups: [{ name: "Mixed", sessions: entries }], onToggleFavorite: favorite, onOpen, onEdit: edit });
    for (const [index, session] of entries.entries()) {
      const row = screen.getByText(session.name).closest("button")!;
      const icon = row.querySelector("svg")!;
      expect(icon.getAttribute("data-session-type")).toBe(index === 0 ? "ssh" : locals[index - 1].shell);
      expect(icon.getAttribute("aria-hidden")).toBe("true"); expect(icon.hasAttribute("tabindex")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: `sessions.filterFavorites ${session.name}` }));
      expect(favorite).toHaveBeenLastCalledWith(session.id);
      fireEvent.contextMenu(icon); fireEvent.click(screen.getByRole("menuitem", { name: index === 0 ? "sessions.contextConnect" : "local.start" }));
      expect(onOpen).toHaveBeenLastCalledWith(session.id);
      act(() => row.focus()); key("ContextMenu"); fireEvent.click(screen.getByRole("menuitem", { name: "sessions.edit" }));
      expect(edit).toHaveBeenLastCalledWith(session.id, row);
    }
  });
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

describe("终端列表启动手势", () => {
  const cases = ["ssh", "cmd", "powershell", "gitBash"] as const;
  function fixture(kind: typeof cases[number]) {
    const session = kind === "ssh" ? group("Start").sessions[0] : {
      kind: "local" as const, id: kind, name: "Local-" + kind, shell: kind,
      group: "Start", tags: [], startingDirectory: "", runAsAdmin: true,
    };
    const onOpen = vi.fn();
    setup({ groups: [{ name: "Start", sessions: [session] }], onOpen });
    return {session, onOpen, row:screen.getByText(session.name).closest("button")!};
  }
  it.each(cases)("%s 单击不打开，每次双击只发出一次新标签启动请求", kind => {
    const {session, onOpen, row}=fixture(kind);
    fireEvent.click(row,{detail:1});expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(row,{detail:2});fireEvent.doubleClick(row);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(session.id,true);
    fireEvent.click(row,{detail:3});expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.click(row,{detail:1});fireEvent.click(row,{detail:2});
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
  it.each(cases)("%s Enter／空格启动，阻止长按及输入法组合重复激活", kind=>{
    const {session,onOpen,row}=fixture(kind);
    for(const key of ["Enter"," "]){
      expect(fireEvent.keyDown(row,{key})).toBe(false);
      fireEvent.keyDown(row,{key,repeat:true});fireEvent.keyDown(row,{key,isComposing:true});fireEvent.keyDown(row,{key,keyCode:229});fireEvent.keyUp(row,{key});
    }
    expect(onOpen).toHaveBeenCalledTimes(2);expect(onOpen).toHaveBeenLastCalledWith(session.id,true);
    fireEvent.click(row,{detail:0});expect(onOpen).toHaveBeenCalledTimes(3);
  });
  it.each(["query","favorites"] as const)("%s 筛选不影响双击启动", mode=>{
    const onOpen=vi.fn();setup({query:mode==="query"?"Session-A":"",filter:mode==="favorites"?"favorites":"all",favoriteSessionIds:["A"],onOpen});
    const row=screen.getByText("Session-A").closest("button")!;
    fireEvent.click(row,{detail:1});fireEvent.click(row,{detail:2});expect(onOpen).toHaveBeenCalledExactlyOnceWith("A",true);
  });
  it("收藏与分组双击不创建标签",()=>{
    const onOpen=vi.fn(),favorite=vi.fn();setup({onOpen,onToggleFavorite:favorite});
    const star=screen.getByRole("button",{name:"sessions.filterFavorites Session-A"});
    fireEvent.click(star,{detail:1});fireEvent.click(star,{detail:2});fireEvent.doubleClick(star);
    fireEvent.click(button("A"),{detail:2});expect(onOpen).not.toHaveBeenCalled();expect(favorite).toHaveBeenCalledWith("A");
  });
  it.each(["drop","cancel"] as const)("拖动 %s 后抑制启动，下一次双击仍可启动", mode=>{
    const onOpen=vi.fn(),reorder=vi.fn().mockResolvedValue(true);setup({onOpen,onReorderSession:reorder});
    const source=screen.getByText("Session-A").closest("button")!;const target=screen.getByText("Session-B").closest("button")!;
    Object.defineProperties(source,{setPointerCapture:{configurable:true,value:vi.fn()},hasPointerCapture:{configurable:true,value:()=>true},releasePointerCapture:{configurable:true,value:vi.fn()}});
    const previous=Object.getOwnPropertyDescriptor(document,"elementFromPoint");Object.defineProperty(document,"elementFromPoint",{configurable:true,value:()=>target});
    try{
      fireEvent.pointerDown(source,{button:0,pointerType:"mouse",pointerId:1,clientX:0,clientY:0});
      fireEvent.pointerMove(source,{pointerId:1,clientX:30,clientY:20});
      if(mode==="drop")fireEvent.pointerUp(source,{pointerId:1,clientX:30,clientY:20});else fireEvent.pointerCancel(source,{pointerId:1});
      fireEvent.click(source,{detail:2});expect(onOpen).not.toHaveBeenCalled();
      if(mode==="drop")expect(reorder).toHaveBeenCalledWith("A","B",1);else expect(reorder).not.toHaveBeenCalled();
      fireEvent.click(source,{detail:1});fireEvent.click(source,{detail:2});expect(onOpen).toHaveBeenCalledExactlyOnceWith("A",true);
    }finally{if(previous)Object.defineProperty(document,"elementFromPoint",previous);else Reflect.deleteProperty(document,"elementFromPoint");}
  });
});

it("列表启动不接管 Ctrl／Alt／Meta 组合快捷键",()=>{
 const onOpen=vi.fn();setup({onOpen});const row=screen.getByText("Session-A").closest("button")!;
 for(const modifiers of [{ctrlKey:true},{altKey:true},{metaKey:true}])for(const key of ["Enter"," "]){
   expect(fireEvent.keyDown(row,{key,...modifiers})).toBe(true);
   fireEvent.click(row,{detail:0,...modifiers});
 }
 expect(onOpen).not.toHaveBeenCalled();
});
