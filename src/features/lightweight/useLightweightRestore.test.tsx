// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeLightweightMode, markPreservedTerminalAttached, markPreservedTerminalFailed,
} from "./lightweightMode";
import { useLightweightRestore } from "./useLightweightRestore";

const mocks = vi.hoisted(() => ({ finish: vi.fn<(ids: string[]) => Promise<void>>() }));
vi.mock("../../shared/api/client", () => ({ api: { finishLightweightRestore: mocks.finish } }));

afterEach(cleanup);
beforeEach(() => {
  mocks.finish.mockReset().mockResolvedValue(undefined);
  initializeLightweightMode({ active: true, suppressConfirmation: false, phase: "detached", terminals: [], transferJobs: [] });
});

describe("轻量恢复收尾", () => {
  it("等待会话加载及全部有效终端就绪，再提交成功标签", async () => {
    initializeLightweightMode({
      active: true, suppressConfirmation: false, phase: "detached", transferJobs: [],
      terminals: ["good", "failed", "orphan"].map((runtimeId) => ({ runtimeId, connectionId: runtimeId, sessionId: "session", currentPath: "/" })),
    });
    const ids = new Set(["good", "failed", "new"]);
    const { rerender } = renderHook(({ ready }) => useLightweightRestore(ids, ready, "失败"), { initialProps: { ready: false } });
    expect(mocks.finish).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(mocks.finish).not.toHaveBeenCalled();
    act(() => markPreservedTerminalAttached("good"));
    expect(mocks.finish).not.toHaveBeenCalled();
    act(() => markPreservedTerminalFailed("failed"));
    await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith(["good", "new"]));
  });

  it("StrictMode 只提交一次，失败后可显式重试恢复", async () => {
    mocks.finish.mockRejectedValueOnce(new Error("保存失败"));
    const ids = new Set<string>();
    const { result } = renderHook(() => useLightweightRestore(ids, true, "失败"), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.error).toContain("保存失败"));
    expect(mocks.finish).toHaveBeenCalledOnce();
    act(() => result.current.retry());
    await waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(2));
    expect(result.current.error).toBeNull();
  });

  it("卸载后忽略迟到失败且不触发自动重试", async () => {
    let reject!: (error: Error) => void;
    mocks.finish.mockReturnValueOnce(new Promise((_, nextReject) => { reject = nextReject; }));
    const ids = new Set<string>();
    const { result, unmount } = renderHook(() => useLightweightRestore(ids, true, "失败"));
    unmount();
    await act(async () => reject(new Error("迟到失败")));
    expect(result.current.error).toBeNull();
    expect(mocks.finish).toHaveBeenCalledOnce();
  });
});
