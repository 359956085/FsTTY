// @vitest-environment jsdom

import { StrictMode, useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  getAppSettings: vi.fn(() => new Promise(() => undefined)),
  sessionMounts: vi.fn(),
  sessionUnmounts: vi.fn(),
}));

vi.mock("./features/sessions/SessionsPage", () => ({
  SessionsPage: () => {
    useEffect(() => {
      mocks.sessionMounts();
      return () => {
        mocks.sessionUnmounts();
      };
    }, []);
    return <div>sessions-content-ready</div>;
  },
}));
vi.mock("./features/settings/SettingsPage", () => ({
  SettingsPage: () => <div>settings-content-ready</div>,
}));
vi.mock("./features/settings/UpdateDialog", () => ({ UpdateDialog: () => null }));
vi.mock("./features/settings/useAppUpdater", () => ({ useAppUpdater: () => ({}) }));
vi.mock("./shared/api/client", () => ({
  api: { getAppSettings: mocks.getAppSettings },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { changeLanguage: vi.fn(), t: (key: string) => key },
    t: (key: string) => key,
  }),
}));

describe("应用页面导航", () => {
  beforeEach(() => vi.clearAllMocks());

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

    fireEvent.click(screen.getByRole("button", { name: "nav.sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "nav.settings" }));
    expect(mocks.sessionMounts).toHaveBeenCalledTimes(2);
    expect(mocks.sessionUnmounts).toHaveBeenCalledTimes(1);
  });
});
