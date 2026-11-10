// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalFontSize } from "./useTerminalFontSize";

const save = vi.hoisted(() => vi.fn());
vi.mock("../../shared/api/client", () => ({ api: { setTerminalFontSize: save } }));
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
beforeEach(() => { vi.useFakeTimers(); save.mockReset().mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("global terminal font size", () => {
  it("defaults to 13, restores settings and rejects invalid sizes", async () => {
    const saved = vi.fn();
    const { result } = renderHook(() => useTerminalFontSize(saved));
    expect(result.current.fontSize).toBe(13);
    act(() => result.current.initialize(19));
    for (const value of [7, 33, 12.5, NaN, Infinity]) act(() => result.current.change(value));
    await advance(300);
    expect(result.current.fontSize).toBe(19);
    expect(save).not.toHaveBeenCalled();
  });

  it("updates immediately and coalesces wheel bursts after 300ms", async () => {
    const saved = vi.fn();
    const { result } = renderHook(() => useTerminalFontSize(saved));
    act(() => result.current.adjust(1));
    expect(result.current.fontSize).toBe(14);
    await advance(200);
    act(() => result.current.adjust(2));
    await advance(299);
    expect(save).not.toHaveBeenCalled();
    await advance(1);
    expect(save.mock.calls).toEqual([[16]]);
    expect(saved.mock.calls).toEqual([[16]]);
    act(() => result.current.adjust(100));
    expect(result.current.fontSize).toBe(32);
    await advance(300);
    act(() => result.current.adjust(1));
    await advance(300);
    expect(save).toHaveBeenCalledTimes(2);
    act(() => result.current.adjust(-100));
    expect(result.current.fontSize).toBe(8);
  });

  it("serializes requests and never applies an old settings snapshot", async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    const saved = vi.fn();
    const { result } = renderHook(() => useTerminalFontSize(saved));
    act(() => result.current.change(16));
    await advance(0);
    act(() => result.current.adjust(2));
    await advance(300);
    expect(save.mock.calls).toEqual([[16]]);
    await act(async () => first.resolve());
    expect(save.mock.calls).toEqual([[16], [18]]);
    expect(result.current.fontSize).toBe(18);
    // Only the requested number is applied, never the other fields of a full response.
    expect(saved.mock.calls).toEqual([[16], [18]]);
  });

  it("reverts to the last successful save and reports failure", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useTerminalFontSize(vi.fn()));
    act(() => result.current.initialize(15));
    act(() => result.current.change(20));
    await advance(0);
    expect(result.current.fontSize).toBe(15);
    expect(result.current.error).toEqual(new Error("disk full"));
    expect(result.current.saving).toBe(false);
  });

  it("an earlier failure preserves and saves the latest request", async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useTerminalFontSize(vi.fn()));
    act(() => result.current.change(16));
    await advance(0);
    act(() => result.current.change(18));
    await advance(0);
    await act(async () => first.reject(new Error("first failed")));
    expect(result.current.fontSize).toBe(18);
    expect(result.current.error).toBeNull();
    expect(save.mock.calls).toEqual([[16], [18]]);
  });

  it("flushes pending/in-flight changes before closing or lightweight detach", async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useTerminalFontSize(vi.fn()));
    act(() => result.current.adjust(1));
    let flushing!: Promise<void>;
    act(() => { flushing = result.current.flush(); });
    expect(save).toHaveBeenCalledWith(14);
    act(() => result.current.adjust(1));
    await act(async () => { first.resolve(); await flushing; });
    expect(save.mock.calls).toEqual([[14], [15]]);
    await advance(300);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
