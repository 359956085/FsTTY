// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../shared/i18n";
import type { LocalUploadDirectory, LocalUploadEntry } from "../../shared/api/types";
import { LocalUploadPicker } from "./LocalUploadPicker";
import { compactUploadSelection } from "./uploadSelection";
const mocks = vi.hoisted(() => ({ locations: vi.fn(), list: vi.fn() }));
vi.mock("../../shared/api/client", () => ({ api: { getLocalUploadLocations: mocks.locations, listLocalUploadEntries: mocks.list } }));
const entry = (name: string, kind: LocalUploadEntry["kind"] = "file", parent = "/local"): LocalUploadEntry => ({ name, path: parent + "/" + name, kind, size: kind === "file" ? 12 : null, modifiedAt: null });
const directory = (path: string, entries: LocalUploadEntry[]): LocalUploadDirectory => ({ path, parent: "/", entries, truncated: false });
beforeEach(() => { mocks.locations.mockResolvedValue({ locations: [{ label: "home", path: "/local" }], initialPath: "/local" }); mocks.list.mockResolvedValue(directory("/local", [entry("文档.txt"), entry("folder", "folder"), entry("link", "symlink")])); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("local upload picker", () => {
  it("supports files, folders and cross-directory selection without submitting early", async () => {
    const upload = vi.fn();
    const close = vi.fn();
    render(<LocalUploadPicker remoteDirectory="/srv" onClose={close} onUpload={upload}/>);
    fireEvent.click(await screen.findByRole("checkbox", { name: "文档.txt" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "folder" }));
    expect(screen.getByRole("checkbox", { name: "link" }).hasAttribute("disabled")).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "上传（2）" }));
    await waitFor(() => expect(upload).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining(["/local/folder", "/local/文档.txt"])));
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps selected files while entering another folder and removes duplicated children", async () => {
    const upload = vi.fn();
    render(<LocalUploadPicker remoteDirectory="/srv" onClose={vi.fn()} onUpload={upload}/>);
    fireEvent.click(await screen.findByRole("checkbox", { name: "文档.txt" }));
    mocks.list.mockResolvedValue(directory("/local/folder", [entry("nested", "file", "/local/folder")]));
    fireEvent.doubleClick(screen.getByText("folder"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "nested" }));
    fireEvent.click(screen.getByRole("button", { name: "上传（2）" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(["/local/文档.txt", "/local/folder/nested"]));
    expect(compactUploadSelection([entry("nested", "file", "/local/folder"), entry("folder", "folder")]).map(e => e.path)).toEqual(["/local/folder"]);
  });
  it("ignores late navigation responses and handles read errors without losing selection", async () => {
    let late!: (value: LocalUploadDirectory) => void;
    const pending = new Promise<LocalUploadDirectory>(resolve => { late = resolve; });
    render(<LocalUploadPicker remoteDirectory="/srv" onClose={vi.fn()} onUpload={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("checkbox", { name: "文档.txt" }));
    mocks.list.mockReturnValueOnce(pending).mockResolvedValueOnce(directory("/latest", [entry("latest", "file", "/latest")]));
    const input = screen.getByRole("textbox", { name: "本地路径" });
    fireEvent.change(input, { target: { value: "/slow" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "/latest" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("latest");
    late(directory("/slow", [entry("stale")]));
    await waitFor(() => expect(screen.queryByText("stale")).toBeNull());
    expect(screen.getByRole("button", { name: "上传（1）" })).toBeDefined();
    mocks.list.mockRejectedValueOnce(new Error("denied"));
    fireEvent.change(input, { target: { value: "/denied" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("/local/文档.txt")).toBeDefined();
  });
  it("restores focus after Escape and does not submit", async () => { const button = document.createElement("button"); document.body.append(button); button.focus(); const close = vi.fn(); const upload = vi.fn(); const { unmount } = render(<LocalUploadPicker remoteDirectory="/srv" onClose={close} onUpload={upload} returnFocus={() => button}/>); await screen.findByRole("checkbox", { name: "文档.txt" }); fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(close).toHaveBeenCalledOnce(); unmount(); expect(document.activeElement).toBe(button); expect(upload).not.toHaveBeenCalled(); button.remove(); });
});
it("Shift range and keyboard select-all keep selection bounded", async () => {
  mocks.list.mockResolvedValue(directory("/local", [entry("a"), entry("b"), entry("c")]));
  const upload = vi.fn();
  render(<LocalUploadPicker remoteDirectory="/srv" onClose={vi.fn()} onUpload={upload}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "a" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "c" }), { shiftKey: true });
  expect((screen.getByRole("checkbox", { name: "b" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "上传（3）" }));
  await waitFor(() => expect(upload).toHaveBeenCalledExactlyOnceWith(["/local/a", "/local/b", "/local/c"]));
});
it("bulk selection rejects more than the allowed root count", async () => {
  mocks.list.mockResolvedValue(directory("/local", Array.from({ length: 257 }, (_, index) => entry(String(index)))));
  render(<LocalUploadPicker remoteDirectory="/srv" onClose={vi.fn()} onUpload={vi.fn()}/>);
  await screen.findByRole("checkbox", { name: "0" });
  fireEvent.keyDown(screen.getByRole("grid"), { key: "a", ctrlKey: true });
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByRole("button", { name: "上传（0）" }).hasAttribute("disabled")).toBe(true);
});
