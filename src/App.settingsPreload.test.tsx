// @vitest-environment jsdom

import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  getAppSettings: vi.fn(() => new Promise(() => {})),
  preload: vi.fn(),
}));

vi.mock("./features/settings/settingsPageLoader", () => ({
  settingsPageLoader: {
    load: vi.fn().mockResolvedValue({ default: () => null }),
    preload: mocks.preload,
  },
}));

vi.mock("./features/sessions/SessionsPage", () => ({ SessionsPage: () => null }));
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

describe("应用启动预加载", () => {
  beforeEach(() => {
    mocks.preload.mockClear();
    mocks.getAppSettings.mockClear();
  });

  it("首屏挂载后立即预加载设置页", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.preload).toHaveBeenCalled());
  });
});
