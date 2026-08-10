// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistorySettingsSection } from "./CommandHistorySettingsSection";

const mocks = vi.hoisted(() => ({
  getCommandHistorySettings: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({ api: mocks }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandHistorySettingsSection", () => {
  it("StrictMode 重放复用加载请求", async () => {
    mocks.getCommandHistorySettings.mockResolvedValue({
      deduplicate: false,
      duplicateCount: 0,
      entryCount: 3,
    });

    render(
      <StrictMode>
        <CommandHistorySettingsSection />
      </StrictMode>,
    );

    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(false),
    );
    expect(mocks.getCommandHistorySettings).toHaveBeenCalledTimes(1);
  });
});
