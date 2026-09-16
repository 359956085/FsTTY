// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstallationSection } from "./InstallationSection";

const mocks = vi.hoisted(() => ({ get: vi.fn(), repair: vi.fn(), t: (key: string) => key }));
vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => true }));
vi.mock("../../shared/api/client", () => ({ api: { getInstallationStatus: mocks.get, repairInstallationEntries: mocks.repair } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
describe("安装入口修复", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("显示当前目录和失败项，重试后提示重启 Agent", async () => {
    mocks.get.mockResolvedValue({ directory: "D:/Apps/FsTTY", issues: ["快捷方式被占用"], restartAgent: false });
    mocks.repair.mockResolvedValue({ directory: "D:/Apps/FsTTY", issues: [], restartAgent: true });
    render(<InstallationSection />);
    expect(await screen.findByText("快捷方式被占用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "installation.repair" }));
    await waitFor(() => expect(screen.queryByText("快捷方式被占用")).toBeNull());
    expect(screen.getByText("installation.restartAgent")).toBeTruthy();
  });
});
