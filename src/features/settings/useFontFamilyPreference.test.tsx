// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFontFamilyPreference } from "./useFontFamilyPreference";

const save = vi.hoisted(() => vi.fn());
vi.mock("../../shared/api/client", () => ({ api: { setFontFamily: save } }));
beforeEach(() => { save.mockReset().mockResolvedValue({}); });
afterEach(cleanup);

describe("font preference persistence", () => {
  it("initializes old preferences and saves only the selected field", async () => {
    const saved = vi.fn();
    const view = renderHook(() => useFontFamilyPreference(saved));
    expect(view.result.current.preference).toBe("default");
    act(() => view.result.current.initialize("consolas"));
    await act(async () => { view.result.current.change("jetBrainsMono"); await view.result.current.flush(); });
    expect(saved.mock.calls).toEqual([["jetBrainsMono"]]);
    expect(save.mock.calls).toEqual([["jetBrainsMono"]]);
  });

  it.each([true, false])("serializes and keeps the latest request when the earlier save succeeds=%s", async (success) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    save.mockReturnValueOnce(new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
    const view = renderHook(() => useFontFamilyPreference(vi.fn()));
    act(() => view.result.current.change("jetBrainsMono"));
    act(() => view.result.current.change("firaCode"));
    act(() => view.result.current.change("consolas"));
    expect(save.mock.calls).toEqual([["jetBrainsMono"]]);
    await act(async () => {
      if (success) finish(); else fail(new Error("old failure"));
      await view.result.current.flush();
    });
    expect(save.mock.calls).toEqual([["jetBrainsMono"], ["consolas"]]);
    expect(view.result.current.preference).toBe("consolas");
    expect(view.result.current.error).toBeNull();
  });

  it("restores the last saved preference on failure without retrying forever", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    const view = renderHook(() => useFontFamilyPreference(vi.fn()));
    act(() => view.result.current.initialize("consolas"));
    await act(async () => { view.result.current.change("jetBrainsMono"); await view.result.current.flush(); });
    expect(view.result.current.preference).toBe("consolas");
    expect(view.result.current.error).toEqual(new Error("disk full"));
    expect(save).toHaveBeenCalledOnce();
    expect(view.result.current.saving).toBe(false);
  });
});
