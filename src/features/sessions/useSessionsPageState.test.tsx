// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionGroup } from "../../shared/api/types";
import { useSessionsPageState } from "./useSessionsPageState";

const mocks = vi.hoisted(() => ({
  listWorkspaceSessions: vi.fn(),
  renameSessionGroup: vi.fn(),
  saveLocalSession: vi.fn(),
}));

vi.mock("../../shared/api/client", () => ({
  api: {
    listWorkspaceSessions: mocks.listWorkspaceSessions,
    renameSessionGroup: mocks.renameSessionGroup,
    saveLocalSession: mocks.saveLocalSession,
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(id: string, group: string): Session {
  return {
    auth: { kind: "password" },
    credentialState: "missing",
    group,
    host: "127.0.0.1",
    id,
    loginSavePrompted: false,
    name: id,
    port: 22,
    tags: [],
    username: "root",
  };
}

function groups(id: string, group = "默认"): SessionGroup[] {
  return [{ name: group, sessions: [session(id, group)] }];
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.renameSessionGroup.mockResolvedValue(undefined);
});

describe("会话列表异步生命周期", () => {
  it("本地配置保存后新建标签，重复打开独立标签，编辑仅更新配置", async () => {
    const local = { kind: "local" as const, id: "local", name: "CMD", group: "默认", tags: [], shell: "cmd" as const, startingDirectory: "", runAsAdmin: true };
    mocks.listWorkspaceSessions.mockResolvedValue(groups("ssh"));
    mocks.saveLocalSession.mockResolvedValue(local);
    const { result } = renderHook(() => useSessionsPageState({ confirmDeleteText: "delete", errorFallback: "error" }));
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    await act(async () => { await result.current.saveLocalSession({ name: "CMD", group: "默认", shell: "cmd", startingDirectory: "", runAsAdmin: true }); });
    expect(result.current.openSessionTabs).toHaveLength(1); expect(result.current.openSessionTabs[0].autoConnect).toBe(true);
    const first = result.current.openSessionTabs[0].id;
    act(() => result.current.openSessionTab(local.id, true, false));
    expect(result.current.openSessionTabs).toHaveLength(2); expect(result.current.openSessionTabs[1].id).not.toBe(first); expect(result.current.openSessionTabs[1].runAsAdmin).toBe(false);
    const ids = result.current.openSessionTabs.map((tab) => tab.id);
    mocks.saveLocalSession.mockResolvedValue({ ...local, name: "Edited", startingDirectory: "C:\\Next" });
    await act(async () => { await result.current.saveLocalSession({ id: local.id, name: "Edited", group: local.group, shell: local.shell, startingDirectory: "C:\\Next", runAsAdmin: true }); });
    expect(result.current.openSessionTabs.map((tab) => tab.id)).toEqual(ids);
    expect(result.current.openSessionTabs.every((tab) => tab.session.name === "Edited")).toBe(true);
  });
  it("刷新时丢弃晚到的旧列表", async () => {
    const first = deferred<SessionGroup[]>();
    const second = deferred<SessionGroup[]>();
    mocks.listWorkspaceSessions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useSessionsPageState({
        confirmDeleteText: "确认删除",
        errorFallback: "未知错误",
      }),
    );

    act(() => {
      void result.current.refreshSessions();
    });
    second.resolve(groups("new-session"));
    await waitFor(() => expect(result.current.sessions[0]?.id).toBe("new-session"));

    first.resolve(groups("old-session"));
    await act(async () => Promise.resolve());
    expect(result.current.sessions[0]?.id).toBe("new-session");
  });

  it("并发分组操作只提交第一次", async () => {
    const initial = groups("session-1", "旧分组");
    mocks.listWorkspaceSessions.mockResolvedValue(initial);
    const rename = deferred<void>();
    mocks.renameSessionGroup.mockReturnValue(rename.promise);
    const { result } = renderHook(() =>
      useSessionsPageState({
        confirmDeleteText: "确认删除",
        errorFallback: "未知错误",
      }),
    );
    await waitFor(() => expect(result.current.groups).toEqual(initial));

    let firstResult!: Awaited<ReturnType<typeof result.current.renameGroup>>;
    let secondResult!: Awaited<ReturnType<typeof result.current.renameGroup>>;
    await act(async () => {
      const firstPromise = result.current.renameGroup("旧分组", "新分组");
      const secondPromise = result.current.renameGroup("旧分组", "另一个分组");
      rename.resolve();
      [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    });

    expect(mocks.renameSessionGroup).toHaveBeenCalledTimes(1);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(false);
    expect(result.current.groups[0]?.name).toBe("新分组");
  });
});
