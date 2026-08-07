// @vitest-environment jsdom

import { StrictMode, useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSettingsPageLoader } from "./settingsPageLoader";

function StubSettingsPage() {
  return null;
}

function PreloadHarness({ preload }: { preload: () => void }) {
  useEffect(() => {
    preload();
  }, [preload]);
  return null;
}

describe("设置页加载器", () => {
  it("StrictMode 重放和重复加载只执行一次实际导入", async () => {
    const importer = vi.fn().mockResolvedValue({ SettingsPage: StubSettingsPage });
    const loader = createSettingsPageLoader(importer);

    render(
      <StrictMode>
        <PreloadHarness preload={loader.preload} />
      </StrictMode>,
    );
    const firstLoad = loader.load();
    const secondLoad = loader.load();

    expect(firstLoad).toBe(secondLoad);
    await expect(firstLoad).resolves.toEqual({ default: StubSettingsPage });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("预加载失败后允许重新加载", async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("加载失败"))
      .mockResolvedValueOnce({ SettingsPage: StubSettingsPage });
    const loader = createSettingsPageLoader(importer);

    loader.preload();
    await waitFor(() => expect(importer).toHaveBeenCalledTimes(1));
    await waitFor(async () => {
      await expect(loader.load()).resolves.toEqual({ default: StubSettingsPage });
    });
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
