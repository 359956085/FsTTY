// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontFamilyPreference } from "./api/types";
import { useFontFamily } from "./useFontFamily";

const mock = vi.hoisted(() => ({ load: vi.fn(), apply: vi.fn() }));
vi.mock("./fonts", () => ({ loadBundledFont: mock.load, applyFontFamily: mock.apply }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe("effective global font", () => {
  it("waits for the offline font before applying it to both interface and terminals", async () => {
    let finish!: () => void;
    mock.load.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useFontFamily("jetBrainsMono"));
    expect(result.current.effective).toBe("default");
    await act(async () => finish());
    expect(result.current.effective).toBe("jetBrainsMono");
    expect(mock.apply).toHaveBeenLastCalledWith("jetBrainsMono");
  });

  it("ignores late loads after switching away or unmounting", async () => {
    let finish!: () => void;
    mock.load.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const view = renderHook(({ family }: { family: FontFamilyPreference }) => useFontFamily(family), {
      initialProps: { family: "jetBrainsMono" as FontFamilyPreference },
    });
    view.rerender({ family: "consolas" });
    await act(async () => finish());
    expect(view.result.current.effective).toBe("consolas");
    expect(mock.apply).toHaveBeenLastCalledWith("consolas");
    view.rerender({ family: "jetBrainsMono" });
    view.unmount();
    mock.apply.mockClear();
    await act(async () => finish());
    expect(mock.apply).not.toHaveBeenCalled();
  });

  it("falls back on load failure and retries after changing the selection", async () => {
    mock.load.mockRejectedValueOnce(new Error("missing")).mockResolvedValue(undefined);
    const view = renderHook(({ family }: { family: FontFamilyPreference }) => useFontFamily(family), {
      initialProps: { family: "jetBrainsMono" as FontFamilyPreference },
    });
    await waitFor(() => expect(view.result.current.loadFailed).toBe(true));
    expect(view.result.current.effective).toBe("default");
    view.rerender({ family: "default" });
    view.rerender({ family: "jetBrainsMono" });
    await waitFor(() => expect(view.result.current.effective).toBe("jetBrainsMono"));
    expect(view.result.current.loadFailed).toBe(false);
  });
});
