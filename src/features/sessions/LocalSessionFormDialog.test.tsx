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
afterEach(() => { cleanup(); document.querySelectorAll("[data-test-opener]").forEach((node) => node.remove()); vi.clearAllMocks(); });
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
    fireEvent.keyDown(name, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Tab" }); expect(document.activeElement).toBe(name);
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
});
describe("终端类型选择器", () => {
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
