// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessionFormDialog } from "./LocalSessionFormDialog";
import { SessionTypeDialog } from "./SessionTypeDialog";

const mocks = vi.hoisted(() => ({ detect: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../shared/api/client", () => ({ api: { detectLocalShells: mocks.detect } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); document.querySelectorAll("[data-test-opener]").forEach((node) => node.remove()); vi.resetAllMocks(); });
function fixture() {
  const opener = document.createElement("button"); opener.dataset.testOpener = "true"; document.body.append(opener); opener.focus();
  return { shell: "cmd" as const, groupOptions: ["Servers", "未分组"], onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), returnFocus: () => opener, fallbackFocus: () => null };
}
describe("本地新建表单", () => {
  it.each(["cmd", "powershell", "gitBash"] as const)("%s 先填写表单，保存前无配置和启动副作用", (shell) => {
    const props = fixture(); const { unmount } = render(<LocalSessionFormDialog {...props} shell={shell} />);
    const input = screen.getByLabelText("sessions.name");
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe({ cmd: "CMD", powershell: "PowerShell", gitBash: "Git Bash" }[shell]);
    expect((screen.getByLabelText("local.defaultAdmin") as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(input, { key: "Escape", isComposing: true }); expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "sessions.cancel" }));
    expect(props.onSave).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledOnce();
    unmount(); expect(document.activeElement).toBe(props.returnFocus()); props.returnFocus().remove();
  });
  it("分组菜单优先处理 Esc、组合输入不提交、Tab 双向循环", () => {
    const props = fixture(); render(<LocalSessionFormDialog {...props} />);
    const name = screen.getByLabelText("sessions.name"); const save = screen.getByRole("button", { name: "sessions.save" });
    const close = screen.getByRole("button", { name: "sessions.close" }); close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Tab" }); expect(document.activeElement).toBe(close);
    const group = screen.getByRole("combobox"); group.focus();
    fireEvent.keyDown(group, { key: "ArrowDown" }); expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(group, { key: "Escape" }); expect(screen.queryByRole("listbox")).toBeNull(); expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: "Enter", isComposing: true }); expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(group, { key: "Escape" }); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("保存时禁关和重复提交，失败保留草稿与焦点，管理员默认值可重试", async () => {
    const props = fixture(); let reject!: (error: Error) => void;
    props.onSave.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(<StrictMode><LocalSessionFormDialog {...props} /></StrictMode>);
    const name = screen.getByLabelText("sessions.name");
    fireEvent.change(name, { target: { value: "My terminal" } });
    fireEvent.change(screen.getByLabelText("local.startingDirectory"), { target: { value: "C:\\独立测试 目录" } });
    fireEvent.click(screen.getByLabelText("local.defaultAdmin")); name.focus();
    fireEvent.submit(screen.getByRole("dialog")); fireEvent.submit(screen.getByRole("dialog")); fireEvent.keyDown(name, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "sessions.close" }));
    expect(props.onSave).toHaveBeenCalledOnce(); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error("save failed")));
    expect(screen.getByRole("alert").textContent).toContain("save failed");
    expect((name as HTMLInputElement).value).toBe("My terminal"); expect(document.activeElement).toBe(name);
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(2));
    expect(props.onSave).toHaveBeenLastCalledWith({ id: undefined, name: "My terminal", group: "", shell: "cmd", startingDirectory: "C:\\独立测试 目录", runAsAdmin: true });
  });
  it("编辑恢复配置，普通重渲染不重置草稿或焦点", () => {
    const props = fixture(); const session = { kind: "local" as const, id: "saved", name: "Dev", group: "未分组", tags: [], shell: "cmd" as const, startingDirectory: "C:\\Work", runAsAdmin: true };
    const { rerender } = render(<LocalSessionFormDialog {...props} session={session} />);
    const path = screen.getByLabelText("local.startingDirectory"); path.focus(); fireEvent.change(path, { target: { value: "C:\\New" } });
    rerender(<LocalSessionFormDialog {...props} session={session} groupOptions={["Added"]} />);
    expect(document.activeElement).toBe(path); expect((path as HTMLInputElement).value).toBe("C:\\New");
  });
  it.each([null, "C:\\中文 测试"])("原生目录选择返回 %s 后保留或更新草稿并恢复目录按钮焦点", async (result) => {
    const props = fixture(); let finish!: (result: string | null) => void;
    mocks.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<StrictMode><LocalSessionFormDialog {...props} /></StrictMode>);
    const path = screen.getByLabelText("local.startingDirectory") as HTMLInputElement;
    fireEvent.change(path, { target: { value: "C:\\Draft" } });
    const browse = screen.getByRole("button", { name: "local.browseDirectory" }); browse.focus(); fireEvent.click(browse);
    fireEvent.click(browse); fireEvent.submit(screen.getByRole("dialog"));
    fireEvent.keyDown(window, { key: "Escape" }); fireEvent.click(screen.getByRole("button", { name: "sessions.close" }));
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ directory: true, multiple: false });
    expect(props.onSave).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish(result));
    expect(path.value).toBe(result ?? "C:\\Draft"); expect(document.activeElement).toBe(browse);
    fireEvent.click(screen.getByRole("button", { name: "sessions.close" })); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("目录选择失败保留草稿和按钮焦点，可再次选择", async () => {
    const props = fixture(); mocks.open.mockRejectedValueOnce(new Error("picker failed")).mockResolvedValueOnce(null);
    render(<LocalSessionFormDialog {...props} />);
    const path = screen.getByLabelText("local.startingDirectory") as HTMLInputElement;
    fireEvent.change(path, { target: { value: "C:\\Draft" } });
    const browse = screen.getByRole("button", { name: "local.browseDirectory" });
    await act(async () => { browse.focus(); fireEvent.click(browse); });
    expect(screen.getByRole("alert").textContent).toContain("picker failed");
    expect(path.value).toBe("C:\\Draft"); expect(document.activeElement).toBe(browse);
    await act(async () => fireEvent.click(browse)); expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull(); expect(document.activeElement).toBe(browse);
  });
  it.each([
    { unmounted: true, nested: false }, { unmounted: false, nested: false }, { unmounted: false, nested: true },
  ])("晚到的目录选择结果不抢回已接管焦点的界面，卸载=$unmounted、嵌套=$nested", async ({ unmounted, nested }) => {
    const props = fixture(); let finish!: (result: string | null) => void;
    mocks.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<LocalSessionFormDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "local.browseDirectory" }));
    if (unmounted) view.unmount();
    const next = document.createElement("div"); next.setAttribute("role", "dialog"); next.setAttribute("aria-modal", "true");
    const target = document.createElement("button"); next.append(target);
    (nested ? screen.getByRole("dialog") : document.body).append(next); target.focus();
    try {
      await act(async () => finish("C:\\Late")); expect(document.activeElement).toBe(target);
      view.unmount(); expect(document.activeElement).toBe(nested ? props.returnFocus() : target);
    } finally { next.remove(); }
  });
});
describe("终端类型选择器", () => {
  it.each([
    ["SSH", "ssh"], ["CMD", "cmd"], ["PowerShell", "powershell"], ["Git Bash", "gitBash"],
  ])("%s 整行的图标及检测说明都能直接进入对应表单", async (label, shell) => {
    const props = fixture(); const select = vi.fn();
    mocks.detect.mockResolvedValueOnce([
      { shell: "cmd", available: true, label: "System CMD" },
      { shell: "powershell", available: true, label: "Windows PowerShell 5.1" },
      { shell: "gitBash", available: true, label: "Git for Windows" },
    ]);
    render(<SessionTypeDialog {...props} onSelect={select} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "CMD" }) as HTMLButtonElement).disabled).toBe(false));
    const row = screen.getByRole("button", { name: label });
    const icon = row.querySelector("svg")!; expect(icon.getAttribute("data-session-type")).toBe(shell);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(icon); expect(select).toHaveBeenCalledExactlyOnceWith(shell);
    select.mockClear(); fireEvent.click(row.querySelector(".session-type-status") ?? row);
    expect(select).toHaveBeenCalledExactlyOnceWith(shell);
  });
  it("检测期间仅 SSH 可选，检测完成不重置焦点，顶部关闭和 Tab 循环仍可用", async () => {
    const props = fixture(); let finish!: (value: unknown[]) => void;
    mocks.detect.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(<StrictMode><SessionTypeDialog {...props} onSelect={vi.fn()} /></StrictMode>);
    const close = screen.getByRole("button", { name: "sessions.close" });
    const cancel = screen.getByRole("button", { name: "sessions.cancel" });
    for (const label of ["CMD", "PowerShell", "Git Bash"]) expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    close.focus(); fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab" }); expect(document.activeElement).toBe(close);
    await act(async () => finish([])); expect(document.activeElement).toBe(close);
    fireEvent.click(close); expect(props.onClose).toHaveBeenCalledOnce(); unmount(); expect(document.activeElement).toBe(props.returnFocus());
  });
  it("保留不可用类型与原因，支持重新检测和取消后迟到结果", async () => {
    const props = fixture(); const select = vi.fn();
    mocks.detect.mockResolvedValueOnce([{ shell: "cmd", available: true, label: "CMD" }, { shell: "gitBash", available: false, reason: "Missing Git" }]);
    const { unmount } = render(<SessionTypeDialog {...props} onSelect={select} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "SSH" }));
    expect(fireEvent.keyDown(document.activeElement!, { key: "Enter", isComposing: true })).toBe(false);
    expect(select).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Missing Git")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Git Bash" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "CMD" })); expect(select).toHaveBeenCalledWith("cmd");
    let finish!: (value: unknown[]) => void; mocks.detect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "local.detectAgain" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(props.onClose).toHaveBeenCalledOnce();
    unmount(); await act(async () => finish([])); expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(props.returnFocus());
  });
});
