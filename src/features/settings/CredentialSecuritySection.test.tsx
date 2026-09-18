// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialSecuritySection } from "./CredentialSecuritySection";

const mocks = vi.hoisted(() => ({
  windows: true,
  status: vi.fn(),
  list: vi.fn(),
  migrate: vi.fn(),
  batch: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => mocks.windows }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("../../shared/api/client", () => ({ api: {
  getCredentialServiceStatus: mocks.status,
  listSessions: mocks.list,
  migrateSshCredential: mocks.migrate,
  migrateSshCredentials: mocks.batch,
  repairCredentialService: mocks.repair,
} }));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.windows = true;
  mocks.status.mockResolvedValue({ required: true, available: true, message: null });
  mocks.list.mockResolvedValue([{ name: "test", sessions: [{ id: "one", name: "旧会话", credentialState: "cleanupPending" }] }]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function renderAndOpen() {
  const result = render(<CredentialSecuritySection />);
  fireEvent.click(screen.getByRole("button", { name: "security.manage" }));
  return result;
}

async function waitUntilLoaded() {
  await waitFor(() => expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("false"));
}

describe("凭据管理入口与弹窗", () => {
  it("默认仅显示分组及单行管理入口，不加载状态或列表", () => {
    const { container } = render(<CredentialSecuritySection />);
    expect(screen.getByRole("heading", { name: "security.managementTitle" })).toBeTruthy();
    expect(container.querySelectorAll(".settings-row")).toHaveLength(1);
    expect(screen.getByText("security.title")).toBeTruthy();
    expect(screen.getByRole("button", { name: "security.manage" }).getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("security.boundary")).toBeNull();
    expect(screen.queryByText("旧会话")).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("打开后先查询服务，服务可用才读取会话列表", async () => {
    const request = deferred<{ required: boolean; available: boolean; message: null }>();
    mocks.status.mockReturnValue(request.promise);
    const { container } = renderAndOpen();
    expect(screen.getByRole("dialog", { name: "security.title" })).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByText("security.checking")).toBeTruthy();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () => request.resolve({ required: true, available: true, message: null }));
    await waitUntilLoaded();
    expect(screen.getByText("旧会话")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it.each(["顶部关闭", "底部关闭", "Esc", "蒙层"])("%s 关闭后恢复入口焦点，再打开重新查询", async (method) => {
    renderAndOpen();
    await waitUntilLoaded();
    const trigger = screen.getByRole("button", { name: "security.manage" });
    const dialog = screen.getByRole("dialog");
    if (method === "顶部关闭" || method === "底部关闭") {
      fireEvent.click(within(dialog).getAllByRole("button", { name: "sessions.close" })[method === "顶部关闭" ? 0 : 1]);
    } else if (method === "Esc") {
      fireEvent.keyDown(window, { key: "Escape" });
    } else {
      fireEvent.mouseDown(dialog.parentElement!);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    mocks.list.mockResolvedValue([{ name: "test", sessions: [{ id: "two", name: "新会话", credentialState: "stored" }] }]);
    fireEvent.click(trigger);
    await waitUntilLoaded();
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("旧会话")).toBeNull();
    expect(screen.getByText("新会话")).toBeTruthy();
  });

  it("弹窗内部点击不关闭，Tab 焦点保留在弹窗内", async () => {
    renderAndOpen();
    await waitUntilLoaded();
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(screen.getByText("旧会话"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    const closeButtons = within(dialog).getAllByRole("button", { name: "sessions.close" });
    closeButtons[1].focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeButtons[0]);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(closeButtons[1]);
  });

  it("空列表显示提示，不出现迁移按钮", async () => {
    mocks.list.mockResolvedValue([]);
    renderAndOpen();
    await waitUntilLoaded();
    expect(screen.getByText("security.empty")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button", { name: "security.migrateBatch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "security.migrate" })).toBeNull();
  });

  it("长列表使用独立可滚动区域，仅展示名称和凭据状态", async () => {
    mocks.list.mockResolvedValue([{ name: "test", sessions: Array.from({ length: 80 }, (_, index) => ({
      id: `session-${index}`,
      name: `会话-${index}`,
      credentialState: "stored",
      credential: "不应展示的密码",
      privateKeyPath: "不应展示的私钥路径",
      passphrase: "不应展示的口令",
    })) }]);
    renderAndOpen();
    await waitUntilLoaded();
    const list = screen.getByRole("list");
    expect(list.classList.contains("settings-credential-security-list")).toBe(true);
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(within(list).getAllByRole("listitem")).toHaveLength(80);
    expect(screen.queryByText("不应展示的密码")).toBeNull();
    expect(screen.queryByText("不应展示的私钥路径")).toBeNull();
    expect(screen.queryByText("不应展示的口令")).toBeNull();
  });

  it("首次加载期间禁止重复刷新及关闭", async () => {
    const request = deferred<{ required: boolean; available: boolean; message: null }>();
    mocks.status.mockReturnValue(request.promise);
    renderAndOpen();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "security.refresh" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(within(dialog).getAllByRole("button", { name: "sessions.close" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => request.resolve({ required: true, available: true, message: null }));
    await waitUntilLoaded();
  });

  it("StrictMode 重放复用首次加载请求", async () => {
    render(<StrictMode><CredentialSecuritySection /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "security.manage" }));
    await waitUntilLoaded();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("卸载后忽略未完成的查询，不继续加载会话", async () => {
    const request = deferred<{ required: boolean; available: boolean; message: null }>();
    mocks.status.mockReturnValue(request.promise);
    const { unmount } = renderAndOpen();
    unmount();
    await act(async () => request.resolve({ required: true, available: true, message: null }));
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("其他平台不显示入口，也不加载服务状态", () => {
    mocks.windows = false;
    const { container } = render(<CredentialSecuritySection />);
    expect(container.childElementCount).toBe(0);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("Windows 凭据保护管理", () => {
  it("服务不可用时显示修复入口，不读取旧凭据", async () => {
    mocks.status.mockResolvedValue({ required: true, available: false, message: "服务未安装" });
    renderAndOpen();
    await waitUntilLoaded();
    expect(screen.getByText("security.repairHint")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("服务未安装");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.queryByText("security.migrateBatch")).toBeNull();
  });

  it("旧副本清理失败时继续展示未完成状态", async () => {
    mocks.migrate.mockRejectedValue(new Error("清理失败"));
    renderAndOpen();
    await waitUntilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "security.migrate" }));
    await screen.findByText("清理失败");
    expect(mocks.migrate).toHaveBeenCalledWith("one");
    expect(screen.getByText("security.states.cleanupPending")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("单项迁移完成后重新查询保护状态", async () => {
    mocks.migrate.mockResolvedValue(undefined);
    renderAndOpen();
    await waitUntilLoaded();
    mocks.list.mockResolvedValue([{ name: "test", sessions: [{ id: "one", name: "旧会话", credentialState: "stored" }] }]);
    fireEvent.click(screen.getByRole("button", { name: "security.migrate" }));
    await screen.findByText("security.states.stored");
    await waitUntilLoaded();
    expect(mocks.migrate).toHaveBeenCalledWith("one");
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "security.migrate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "security.migrateBatch" })).toBeNull();
  });

  it("批量迁移只提交最多 32 个未托管会话标识，完成后重新查询", async () => {
    mocks.batch.mockResolvedValue(undefined);
    mocks.list.mockResolvedValue([{ name: "test", sessions: [
      { id: "stored", name: "已托管会话", credentialState: "stored" },
      ...Array.from({ length: 40 }, (_, index) => ({ id: `pending-${index}`, name: `旧会话-${index}`, credentialState: "migrationRequired" })),
    ] }]);
    renderAndOpen();
    await waitUntilLoaded();
    fireEvent.click(screen.getByRole("button", { name: "security.migrateBatch" }));
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledWith(Array.from({ length: 32 }, (_, index) => `pending-${index}`)));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it("服务中断后清除过期保护状态，修复完成再查询", async () => {
    renderAndOpen();
    await waitUntilLoaded();
    mocks.status.mockResolvedValue({ required: true, available: false, message: "服务已停止" });
    fireEvent.click(screen.getByRole("button", { name: "security.refresh" }));
    await waitUntilLoaded();
    expect(screen.queryByRole("button", { name: "security.migrate" })).toBeNull();
    expect(screen.queryByText("旧会话")).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    mocks.repair.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ required: true, available: true, message: null });
    fireEvent.click(screen.getByRole("button", { name: "security.repair" }));
    await screen.findByRole("button", { name: "security.migrate" });
    await waitUntilLoaded();
    expect(mocks.repair).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it.each(["批量迁移", "修复服务"])("%s 失败后显示错误并恢复重试入口", async (operation) => {
    if (operation === "修复服务") {
      mocks.status.mockResolvedValue({ required: true, available: false, message: null });
      mocks.repair.mockRejectedValueOnce(new Error("操作失败"));
    } else {
      mocks.batch.mockRejectedValueOnce(new Error("操作失败"));
    }
    renderAndOpen();
    await waitUntilLoaded();
    const label = operation === "修复服务" ? "security.repair" : "security.migrateBatch";
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("操作失败");
    await waitUntilLoaded();
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.status).toHaveBeenCalledTimes(1);
  });

  it("查询失败展示错误，刷新可重试并清除错误", async () => {
    mocks.status.mockRejectedValueOnce(new Error("查询失败"));
    renderAndOpen();
    await waitUntilLoaded();
    expect(screen.getByRole("alert").textContent).toBe("查询失败");
    expect(screen.getByText("security.statusUnknown")).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "security.refresh" }));
    await screen.findByText("旧会话");
    await waitUntilLoaded();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it("列表查询失败不误报为空，也不显示过期迁移入口", async () => {
    renderAndOpen();
    await waitUntilLoaded();
    mocks.list.mockRejectedValueOnce(new Error("列表加载失败"));
    fireEvent.click(screen.getByRole("button", { name: "security.refresh" }));
    await screen.findByText("列表加载失败");
    await waitUntilLoaded();
    expect(screen.queryByText("旧会话")).toBeNull();
    expect(screen.queryByText("security.empty")).toBeNull();
    expect(screen.queryByRole("button", { name: "security.migrateBatch" })).toBeNull();
  });

  it("迁移期间禁止重复提交、刷新及关闭，完成后恢复", async () => {
    const request = deferred<void>();
    mocks.migrate.mockReturnValue(request.promise);
    renderAndOpen();
    await waitUntilLoaded();
    const migrate = screen.getByRole("button", { name: "security.migrate" });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(migrate);
    fireEvent.click(migrate);
    fireEvent.click(screen.getByRole("button", { name: "security.migrateBatch" }));
    fireEvent.click(screen.getByRole("button", { name: "security.refresh" }));
    fireEvent.click(within(dialog).getAllByRole("button", { name: "sessions.close" })[0]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(mocks.migrate).toHaveBeenCalledTimes(1);
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(undefined));
    await waitUntilLoaded();
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
