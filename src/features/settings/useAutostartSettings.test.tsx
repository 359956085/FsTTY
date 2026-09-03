// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutostartSettings } from "./useAutostartSettings";

const apiMocks = vi.hoisted(() => ({
  getAutostartState: vi.fn(),
  setAutostartEnabled: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({ api: apiMocks }));

const translate = (key: string) => key;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.getAutostartState.mockResolvedValue(false);
  apiMocks.setAutostartEnabled.mockImplementation(async (enabled: boolean) => enabled);
});

afterEach(cleanup);

async function renderReady() {
  const hook = renderHook(() => useAutostartSettings(translate));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("开机自启设置", () => {
  it("初次只读取系统登记，收到真实状态前保持加载", async () => {
    const request = deferred<boolean>();
    apiMocks.getAutostartState.mockReturnValue(request.promise);
    const { result } = renderHook(() => useAutostartSettings(translate));

    expect(result.current.loading).toBe(true);
    expect(result.current.confirmed).toBe(false);
    expect(apiMocks.setAutostartEnabled).not.toHaveBeenCalled();
    await act(async () => request.resolve(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.confirmed).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("读取失败不猜测实际开关，允许重新读取", async () => {
    apiMocks.getAutostartState.mockRejectedValueOnce(new Error("读取失败"));
    const { result } = await renderReady();
    expect(result.current.error).toBe("读取失败");
    expect(result.current.confirmed).toBe(false);

    apiMocks.getAutostartState.mockResolvedValueOnce(true);
    await act(async () => result.current.refresh());
    expect(result.current.enabled).toBe(true);
    expect(result.current.confirmed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("重复点击只提交一次，并使用后端回读的状态", async () => {
    const { result } = await renderReady();
    const request = deferred<boolean>();
    apiMocks.setAutostartEnabled.mockReturnValue(request.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save(true);
      void result.current.save(false);
    });
    expect(apiMocks.setAutostartEnabled).toHaveBeenCalledTimes(1);
    expect(apiMocks.setAutostartEnabled).toHaveBeenCalledWith(true);
    expect(result.current.saving).toBe(true);
    expect(result.current.enabled).toBe(false);

    await act(async () => {
      request.resolve(false);
      await saving;
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("部分写入后失败时回读真实状态，下一次仍可保存", async () => {
    const { result } = await renderReady();
    apiMocks.setAutostartEnabled.mockRejectedValueOnce(new Error("提交失败"));
    apiMocks.getAutostartState.mockResolvedValueOnce(true);
    await act(async () => result.current.save(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBe("提交失败");
    expect(result.current.confirmed).toBe(true);
    expect(result.current.saving).toBe(false);

    await act(async () => result.current.save(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.error).toBeNull();
    expect(apiMocks.setAutostartEnabled).toHaveBeenCalledTimes(2);
  });

  it("写入和回读均失败时保留最后已知值并标记未知", async () => {
    apiMocks.getAutostartState.mockResolvedValueOnce(true);
    const { result } = await renderReady();
    apiMocks.setAutostartEnabled.mockRejectedValueOnce(new Error("写入失败"));
    apiMocks.getAutostartState.mockRejectedValueOnce(new Error("回读失败"));
    await act(async () => result.current.save(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.confirmed).toBe(false);
    expect(result.current.error).toBe("写入失败");
    expect(result.current.saving).toBe(false);
  });

  it("窗口重新聚焦时刷新，只接收最新读取结果", async () => {
    const { result } = await renderReady();
    const oldRequest = deferred<boolean>();
    const newRequest = deferred<boolean>();
    apiMocks.getAutostartState
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => newRequest.resolve(true));
    await act(async () => oldRequest.resolve(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(3);
  });

  it("保存使更早的读取失效，迟到错误不能覆盖新状态", async () => {
    const { result } = await renderReady();
    const oldRequest = deferred<boolean>();
    apiMocks.getAutostartState.mockReturnValueOnce(oldRequest.promise);
    act(() => { void result.current.refresh(); });
    await act(async () => result.current.save(true));
    await act(async () => oldRequest.reject(new Error("过期读取失败")));
    expect(result.current.enabled).toBe(true);
    expect(result.current.confirmed).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("保存期间多次聚焦合并为保存后的单次回读", async () => {
    const { result } = await renderReady();
    const request = deferred<boolean>();
    apiMocks.setAutostartEnabled.mockReturnValueOnce(request.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save(true);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(1);
    await act(async () => {
      request.resolve(true);
      await saving;
    });
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(2);
    expect(result.current.enabled).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("卸载后不回读失败结果，不响应残留回调或聚焦事件", async () => {
    const { result, unmount } = await renderReady();
    const request = deferred<boolean>();
    apiMocks.setAutostartEnabled.mockReturnValueOnce(request.promise);
    const previous = result.current;
    let saving!: Promise<void>;
    act(() => { saving = previous.save(true); });
    unmount();
    request.reject(new Error("迟到失败"));
    await saving;
    await previous.refresh();
    await previous.save(false);
    window.dispatchEvent(new Event("focus"));
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(1);
    expect(apiMocks.setAutostartEnabled).toHaveBeenCalledTimes(1);
  });

  it("保存期间排队的聚焦刷新不隐藏保存失败", async () => {
    const { result } = await renderReady();
    const request = deferred<boolean>();
    apiMocks.setAutostartEnabled.mockReturnValueOnce(request.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save(true);
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      request.reject(new Error("系统拒绝保存"));
      await saving;
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.confirmed).toBe(true);
    expect(result.current.error).toBe("系统拒绝保存");
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(3);
    await act(async () => result.current.refresh());
    expect(result.current.error).toBeNull();
  });

  it("StrictMode 重放丢弃旧生命周期的读取结果", async () => {
    const oldRequest = deferred<boolean>();
    const newRequest = deferred<boolean>();
    apiMocks.getAutostartState
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const { result } = renderHook(() => useAutostartSettings(translate), { wrapper: StrictMode });
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(2);
    await act(async () => newRequest.resolve(true));
    await act(async () => oldRequest.resolve(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.confirmed).toBe(true);
    await act(async () => result.current.save(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("返回设置页时重新读取，不把上次页面状态当作系统配置", async () => {
    const previous = await renderReady();
    previous.unmount();
    apiMocks.getAutostartState.mockResolvedValueOnce(true);
    const current = await renderReady();
    expect(current.result.current.enabled).toBe(true);
    expect(apiMocks.getAutostartState).toHaveBeenCalledTimes(2);
    expect(apiMocks.setAutostartEnabled).not.toHaveBeenCalled();
  });
});
