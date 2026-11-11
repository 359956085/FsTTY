// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../shared/i18n";
import { PermissionDialog } from "./PermissionDialog";
import type { FileEntry } from "../../shared/api/types";
const read = vi.hoisted(() => vi.fn());
vi.mock("../../shared/api/client", () => ({ api: { getRemotePermissions: read } }));
const files: FileEntry[] = [{ name: "dir", path: "/dir", kind: "folder", owner: "user", group: "group", permissions: "drwxr-xr-x (755)" }];
beforeEach(() => read.mockResolvedValue([{ ...files[0], mode: 0o42755, size: 0 }]));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("reads fresh modes, preserves unchanged bits and separates recursive file and folder patches", async () => {
  const apply = vi.fn().mockResolvedValue(undefined);
  render(<PermissionDialog connectionId="conn" files={files} onClose={vi.fn()} onApply={apply}/>);
  await screen.findByRole("checkbox", { name: "递归应用到子项" });
  expect(screen.getByRole("button", { name: "应用" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "递归应用到子项" }));
  fireEvent.change(screen.getByRole("textbox", { name: "文件权限 八进制" }), { target: { value: "640" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "文件夹权限 所属组 写" }));
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ paths: ["/dir"], recursive: true, filePatch: { mask: 0o777, value: 0o640 }, directoryPatch: { mask: 0o020, value: 0o020 } }));
  expect(read).toHaveBeenCalledWith("conn", ["/dir"]);
});
it("rejects invalid octal values and keeps the dialog open after start failure", async () => {
  const apply = vi.fn().mockRejectedValue(new Error("offline"));
  render(<PermissionDialog connectionId="conn" files={files} onClose={vi.fn()} onApply={apply}/>);
  const input = await screen.findByRole("textbox", { name: "文件夹权限 八进制" });
  fireEvent.change(input, { target: { value: "888" } });
  expect(screen.getByRole("button", { name: "应用" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(input, { target: { value: "750" } });
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByRole("dialog")).toBeDefined();
});
it("shows mixed bits and does not force untouched permissions", async () => {
  read.mockResolvedValue([{ ...files[0], kind: "file", mode: 0o100644, size: 1 }, { ...files[0], path: "/b", kind: "file", mode: 0o100600, size: 1 }]);
  render(<PermissionDialog connectionId="conn" files={[{ ...files[0], kind: "file" }, { ...files[0], path: "/b", kind: "file" }]} onClose={vi.fn()} onApply={vi.fn()}/>);
  const group = await screen.findByRole("group", { name: "文件权限" });
  const check = within(group).getByRole("checkbox", { name: "文件权限 所属组 读" });
  expect(check.getAttribute("aria-checked")).toBe("mixed");
  expect(screen.getByRole("button", { name: "应用" }).hasAttribute("disabled")).toBe(true);
});
it("changing back to original permissions disables a no-op submission", async () => {
  render(<PermissionDialog connectionId="conn" files={files} onClose={vi.fn()} onApply={vi.fn()}/>);
  const input = await screen.findByRole("textbox", { name: "文件夹权限 八进制" });
  fireEvent.change(input, { target: { value: "755" } });
  expect(screen.getByRole("button", { name: "应用" }).hasAttribute("disabled")).toBe(true);
  const write = screen.getByRole("checkbox", { name: "文件夹权限 所属组 写" });
  fireEvent.click(write);
  expect(screen.getByRole("button", { name: "应用" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(write);
  expect(screen.getByRole("button", { name: "应用" }).hasAttribute("disabled")).toBe(true);
});
