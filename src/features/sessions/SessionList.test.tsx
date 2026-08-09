// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionGroup } from "../../shared/api/types";
import { SessionList } from "./SessionList";

const mocks = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeText,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function createSession(username: string): Session {
  return {
    id: "session-1",
    name: "Production",
    host: "server.example.com",
    port: 2222,
    username,
    group: "Servers",
    tags: ["sensitive-tag"],
    auth: { kind: "password" },
    credentialState: "stored",
    loginSavePrompted: false,
  };
}

function renderSessionList(session: Session) {
  const groups: SessionGroup[] = [{ name: "Servers", sessions: [session] }];
  return render(
    <SessionList
      collapsedGroupNames={[]}
      favoriteSessionIds={[]}
      filter="all"
      groups={groups}
      mutationPending={false}
      onCollapse={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onDeleteGroup={vi.fn().mockResolvedValue({ ok: true, value: [] })}
      onEdit={vi.fn()}
      onFilterChange={vi.fn()}
      onOpen={vi.fn()}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
      onRenameGroup={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      onReorderGroup={vi.fn().mockResolvedValue(true)}
      onReorderSession={vi.fn().mockResolvedValue(true)}
      onToggleFavorite={vi.fn()}
      onToggleGroup={vi.fn()}
      query=""
    />,
  );
}

function openCopyMenu() {
  fireEvent.contextMenu(screen.getByText("Production"));
  return screen.getByRole("menuitem", {
    name: "sessions.contextCopySessionInfo",
  });
}

describe("SessionList 复制会话信息", () => {
  it("只复制会话名、账号和主机地址", () => {
    mocks.writeText.mockResolvedValue();
    renderSessionList(createSession("ubuntu"));

    fireEvent.click(openCopyMenu());

    expect(mocks.writeText).toHaveBeenCalledWith(
      "Production ubuntu@server.example.com",
    );
  });

  it("账号为空时只在会话名后附加主机地址", () => {
    mocks.writeText.mockResolvedValue();
    renderSessionList(createSession(""));

    fireEvent.click(openCopyMenu());

    expect(mocks.writeText).toHaveBeenCalledWith(
      "Production server.example.com",
    );
  });

  it("复制失败时显示错误并在三秒后清除", async () => {
    vi.useFakeTimers();
    mocks.writeText.mockRejectedValue(new Error("clipboard busy"));
    renderSessionList(createSession("ubuntu"));
    const copyMenuItem = openCopyMenu();

    await act(async () => {
      fireEvent.click(copyMenuItem);
      await Promise.resolve();
    });

    expect(screen.getByRole("alert").textContent).toBe(
      "sessions.copySessionInfoFailed",
    );

    await act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
