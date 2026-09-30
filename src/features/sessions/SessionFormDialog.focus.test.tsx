// @vitest-environment jsdom
import { StrictMode, useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/api/types";
import { SessionFormDialog } from "./SessionFormDialog";

const mocks = vi.hoisted(() => ({ broker: true, locale: "", manage: vi.fn() }));
vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => mocks.broker }));
vi.mock("../../shared/api/client", () => ({ api: { manageSshCredential: mocks.manage } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => mocks.locale + key }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));

const session: Session = {
  id: "session", name: "Server", host: "example.test", port: 22, username: "test", group: "Servers",
  tags: [], auth: { kind: "password" }, credentialState: "stored", loginSavePrompted: false,
};
const defaults: ComponentProps<typeof SessionFormDialog> = {
  mode: "create", groupOptions: ["Servers"], onClose: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); mocks.broker = true; mocks.locale = ""; vi.clearAllMocks(); });

describe("会话表单键盘交互", () => {
  it.each(["create", "edit"] as const)("%s 首次聚焦主机，Tab 首尾循环，关闭恢复入口", (mode) => {
    function Owner() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>open</button>{open &&
        <SessionFormDialog {...defaults} mode={mode} session={mode === "edit" ? session : undefined} onClose={() => setOpen(false)} />}</>;
    }
    render(<StrictMode><Owner /></StrictMode>);
    const opener = screen.getByText("open");
    for (let i = 0; i < 2; i += 1) {
      opener.focus();
      fireEvent.click(opener);
      expect(document.activeElement).toBe(screen.getByLabelText(/sessions.host/));
      expect(screen.getByRole("dialog", { name: `sessions.${mode}Title` })).toBeTruthy();
      const close = screen.getByRole("button", { name: "sessions.close" });
      const save = screen.getByRole("button", { name: "sessions.save" });
      save.focus();
      fireEvent.keyDown(save, { key: "Tab" });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(save);
      fireEvent.keyDown(save, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  });

  it.each(["sessions.group", "sessions.authType"])("%s 菜单先消费 Esc，输入法期间不关闭", (name) => {
    const close = vi.fn();
    render(<SessionFormDialog {...defaults} onClose={close} />);
    const combo = screen.getByRole("combobox", { name });
    combo.focus();
    fireEvent.keyDown(combo, { key: "ArrowDown" });
    expect(combo.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(combo, { key: "Escape" });
    expect(combo.getAttribute("aria-expanded")).toBe("false");
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(combo, { key: "Escape", isComposing: true });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(combo, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("保存中禁用关闭，失败后保留内容与焦点并重新允许关闭", async () => {
    const pending = deferred();
    const close = vi.fn();
    const props = { ...defaults, mode: "edit" as const, session, onClose: close, onSave: vi.fn(() => pending.promise) };
    const { rerender } = render(<SessionFormDialog {...props} />);
    const host = screen.getByLabelText(/sessions.host/) as HTMLInputElement;
    fireEvent.change(host, { target: { value: "changed.test" } });
    fireEvent.click(screen.getByRole("button", { name: "sessions.save" }));
    fireEvent.keyDown(host, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "sessions.close" }));
    expect(close).not.toHaveBeenCalled();
    expect(props.onSave).toHaveBeenCalledOnce();
    rerender(<SessionFormDialog {...props} saveError="保存失败" />);
    await act(async () => pending.resolve());
    expect(host.value).toBe("changed.test");
    expect(document.activeElement).toBe(host);
    expect(screen.getByText("保存失败")).toBeTruthy();
    fireEvent.keyDown(host, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("原生凭据管理期间不能关闭，返回后不重置表单焦点", async () => {
    const pending = deferred();
    mocks.manage.mockReturnValue(pending.promise);
    const close = vi.fn();
    render(<SessionFormDialog {...defaults} mode="edit" session={session} onClose={close} />);
    const host = screen.getByLabelText(/sessions.host/);
    fireEvent.click(screen.getByRole("button", { name: "security.changeCredential" }));
    fireEvent.keyDown(host, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "sessions.close" }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(document.activeElement).toBe(host);
    fireEvent.keyDown(host, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("字段及语言变化不重置焦点，表单蒙层不新增关闭行为", () => {
    mocks.broker = false;
    const close = vi.fn();
    const { rerender } = render(<SessionFormDialog {...defaults} onClose={close} />);
    const auth = screen.getByRole("combobox", { name: "sessions.authType" });
    auth.focus();
    fireEvent.click(auth);
    fireEvent.click(screen.getByRole("option", { name: "sessions.privateKeyAuth" }));
    expect(document.activeElement).toBe(auth);
    expect(screen.getByRole("combobox", { name: "sessions.privateKeySource" })).toBeTruthy();
    mocks.locale = "en:";
    rerender(<SessionFormDialog {...defaults} onClose={close} />);
    expect(document.activeElement).toBe(auth);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(close).not.toHaveBeenCalled();
  });
});
