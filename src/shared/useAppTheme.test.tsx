// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppTheme } from "./useAppTheme";

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn(
    (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  );
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    addEventListener,
    removeEventListener,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe("主题运行时", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("系统主题实时变化且 StrictMode 清理全部监听", () => {
    const media = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useAppTheme("system"), {
      wrapper: StrictMode,
    });
    expect(result.current).toBe("light");
    expect(media.addEventListener).toHaveBeenCalledTimes(2);

    act(() => media.setMatches(true));
    expect(result.current).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    unmount();
    expect(media.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("固定主题不注册系统变化监听", () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useAppTheme("light"));
    expect(result.current).toBe("light");
    expect(media.addEventListener).not.toHaveBeenCalled();
  });
});
