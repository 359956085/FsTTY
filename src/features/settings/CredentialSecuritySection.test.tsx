// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialSecuritySection } from "./CredentialSecuritySection";

const mocks = vi.hoisted(() => ({
  windows: true,
  status: vi.fn(), list: vi.fn(), migrate: vi.fn(), batch: vi.fn(), repair: vi.fn(),
}));
vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => mocks.windows }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("../../shared/api/client", () => ({ api: {
  getCredentialServiceStatus: mocks.status, listSessions: mocks.list,
  migrateSshCredential: mocks.migrate, migrateSshCredentials: mocks.batch,
  repairCredentialService: mocks.repair,
} }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); mocks.windows = true;
  mocks.status.mockResolvedValue({ required: true, available: true, message: null });
  mocks.list.mockResolvedValue([{ name: "test", sessions: [{ id: "one", name: "旧会话", credentialState: "cleanupPending" }] }]);
});
describe("Windows 凭据保护状态", () => {
  it("服务不可用时显示修复入口，不读取旧凭据", async () => {
    mocks.status.mockResolvedValue({ required: true, available: false, message: "服务未安装" });
    render(<CredentialSecuritySection />);
    await screen.findByText("security.repairHint");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.queryByText("security.migrateBatch")).toBeNull();
  });
  it("旧副本清理失败时继续展示未完成状态", async () => {
    mocks.migrate.mockRejectedValue(new Error("清理失败"));
    render(<CredentialSecuritySection />);
    fireEvent.click(await screen.findByRole("button", { name: "security.migrate" }));
    await screen.findByRole("alert");
    expect(mocks.migrate).toHaveBeenCalledWith("one");
    expect(screen.getByText(/security.states.cleanupPending/)).toBeTruthy();
  });
  it("批量迁移只提交会话标识，完成后重新查询保护状态", async () => {
    mocks.batch.mockResolvedValue(undefined);
    render(<CredentialSecuritySection />);
    fireEvent.click(await screen.findByRole("button", { name: "security.migrateBatch" }));
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledWith(["one"]));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });
  it("服务中断后清除过期保护状态，修复完成再查询", async () => {
    render(<CredentialSecuritySection />);
    await screen.findByRole("button", { name: "security.migrate" });
    mocks.status.mockResolvedValue({ required: true, available: false, message: "服务已停止" });
    fireEvent.click(screen.getByRole("button", { name: "security.refresh" }));
    const repair = await screen.findByRole("button", { name: "security.repair" });
    expect(screen.queryByRole("button", { name: "security.migrate" })).toBeNull();
    mocks.repair.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ required: true, available: true, message: null });
    fireEvent.click(repair);
    await screen.findByRole("button", { name: "security.migrate" });
    expect(mocks.repair).toHaveBeenCalledTimes(1);
  });
  it("其他平台不加载服务状态", () => {
    mocks.windows = false; render(<CredentialSecuritySection />);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
