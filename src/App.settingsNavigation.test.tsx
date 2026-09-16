// @vitest-environment jsdom

import { StrictMode, useEffect, useState } from "react";
import type { UsePaneLayoutResult } from "./features/sessions/usePaneLayout";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  getAppSettings: vi.fn(() => new Promise(() => undefined)),
  enterLightweightMode: vi.fn(),
  lightweightState: {
    active: false,
    suppressConfirmation: false,
    phase: "normal",
    terminals: [],
    transferJobs: [],
  },
  sessionMounts: vi.fn(),
  sessionUnmounts: vi.fn(),
  updatePhase: "idle",
}));

vi.mock("./features/sessions/SessionsPage", () => ({
  SessionsPage: ({ paneLayout }: { paneLayout: UsePaneLayoutResult }) => {
    useEffect(() => {
      mocks.sessionMounts();
      return () => {
        mocks.sessionUnmounts();
      };
    }, []);
    return <div data-left-collapsed={paneLayout.layout.leftCollapsed} ref={paneLayout.rootRef}>sessions-content-ready</div>;
  },
}));
vi.mock("./features/settings/SettingsPage", () => ({
  SettingsPage: ({ onBack, sidebarCollapsed }: { onBack: () => void; sidebarCollapsed: boolean }) => {
    const [section, setSection] = useState("general");
    return <div>
      <span>settings-content-ready</span>
      <span>{section}</span>
      <button onClick={onBack}>nav.backToApp</button>
      {!sidebarCollapsed && <button onClick={() => setSection("mcp")}>MCP</button>}
    </div>;
  },
}));
vi.mock("./features/settings/UpdateDialog", () => ({ UpdateDialog: () => null }));
vi.mock("./features/settings/useAppUpdater", () => ({ useAppUpdater: () => ({ phase: mocks.updatePhase }) }));
vi.mock("./features/lightweight/lightweightMode", () => ({
  enterLightweightMode: mocks.enterLightweightMode,
  getInitialLightweightModeState: () => mocks.lightweightState,
}));
vi.mock("./shared/api/client", () => ({
  api: { getAppSettings: mocks.getAppSettings },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { changeLanguage: vi.fn(), t: (key: string) => key },
    t: (key: string) => key,
  }),
}));

afterEach(cleanup);

describe("应用页面导航", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.lightweightState.suppressConfirmation = false;
    mocks.updatePhase = "idle";
    mocks.enterLightweightMode.mockResolvedValue(undefined);
  });

  it("首次打开设置立即显示内容且会话页保持挂载", () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(mocks.sessionMounts).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    expect(screen.getByText("settings-content-ready")).not.toBeNull();
    expect(screen.queryByText("common.loading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "nav.backToApp" }));
    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    expect(mocks.sessionMounts).toHaveBeenCalledTimes(2);
    expect(mocks.sessionUnmounts).toHaveBeenCalledTimes(1);
  });

  it("默认会话页且两页左栏独立记忆，返回后会话不重建", () => {
    render(<App />);
    expect(screen.queryByText("settings-content-ready")).toBeNull();
    expect(screen.queryByRole("button", { name: "nav.sessions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "nav.collapseSessions" }));
    expect(screen.getByText("sessions-content-ready").getAttribute("data-left-collapsed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    expect(screen.getByText("mcp")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "nav.collapseSettings" }));
    expect(screen.queryByRole("button", { name: "MCP" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "nav.backToApp" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "nav.settings" }));
    fireEvent.click(screen.getByRole("button", { name: "nav.expandSessions" }));
    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    expect(screen.getByRole("button", { name: "nav.expandSettings" }).getAttribute("aria-expanded")).toBe("false");
    expect(mocks.sessionMounts).toHaveBeenCalledOnce();
    expect(mocks.sessionUnmounts).not.toHaveBeenCalled();
  });

  it("叶子按钮先确认且取消不会误保存不再提示", async () => {
    render(<App />);
    const leaf = screen.getByRole("button", { name: "lightweight.enter" });
    expect(leaf.classList.contains("lightweight-control")).toBe(true);

    fireEvent.click(leaf);
    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "lightweight.doNotAskAgain" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "sessions.cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(leaf);
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(mocks.enterLightweightMode).not.toHaveBeenCalled();
  });

  it("确认不再提示时把选择提交给轻量事务", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "lightweight.enter" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "lightweight.doNotAskAgain" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "lightweight.confirm" }));

    await waitFor(() => expect(mocks.enterLightweightMode).toHaveBeenCalledWith(true));
  });

  it("保存过不再提示后直接进入且重复点击不重复提交", async () => {
    mocks.lightweightState.suppressConfirmation = true;
    mocks.enterLightweightMode.mockReturnValueOnce(new Promise(() => undefined));
    render(<App />);
    const leaf = screen.getByRole("button", { name: "lightweight.enter" });
    fireEvent.click(leaf);
    fireEvent.click(leaf);
    await waitFor(() => expect(mocks.enterLightweightMode).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("进入失败后按钮可重试且不会保存尚未提交的不再提示", async () => {
    mocks.enterLightweightMode.mockRejectedValueOnce(new Error("保存失败"));
    render(<App />);
    const leaf = screen.getByRole("button", { name: "lightweight.enter" });
    fireEvent.click(leaf);
    fireEvent.click(screen.getByRole("checkbox", { name: "lightweight.doNotAskAgain" }));
    fireEvent.click(screen.getByRole("button", { name: "lightweight.confirm" }));
    await screen.findByText("保存失败");
    fireEvent.click(leaf);
    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("更新下载或安装时阻止进入轻量模式", () => {
    mocks.updatePhase = "downloading";
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "lightweight.enter" }));
    expect(screen.getByText("lightweight.updateBusy")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.enterLightweightMode).not.toHaveBeenCalled();
  });
});
