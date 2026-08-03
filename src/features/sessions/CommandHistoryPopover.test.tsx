// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandHistoryPopover } from "./CommandHistoryPopover";

const mocks = vi.hoisted(() => ({
  listCommandHistory: vi.fn(),
}));

const translate = (key: string) =>
  ({
    "sessions.close": "关闭",
    "sessions.commandHistory": "历史",
    "sessions.commandHistoryEmpty": "暂无历史命令",
    "sessions.commandHistoryLoadFailed": "无法加载历史命令",
    "sessions.commandHistorySearch": "搜索历史命令...",
    "sessions.loading": "加载中...",
    "sessions.refresh": "刷新",
    "sessions.select": "选择",
  })[key] ?? key;

vi.mock("../../shared/api/client", () => ({
  api: { listCommandHistory: mocks.listCommandHistory },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: "zh-CN" },
    t: translate,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const latestPage = {
  entries: [
    { command: "pwd", executedAt: "2026-08-03T01:00:00Z", id: "2" },
    { command: "ls -la", executedAt: "2026-08-03T02:00:00Z", id: "3" },
  ],
  hasMore: true,
  olderCursor: "1:2",
};

describe("CommandHistoryPopover", () => {
  it("单条历史保持列表直接子项结构并选中最新项", async () => {
    mocks.listCommandHistory.mockResolvedValue({
      entries: [{ command: "cd /home/", executedAt: "2026-08-03T03:00:00Z", id: "4" }],
      hasMore: false,
      olderCursor: null,
    });
    render(<CommandHistoryPopover disabled={false} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    const option = await screen.findByRole("option");
    const list = screen.getByRole("listbox");

    expect(option.parentElement).toBe(list);
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(option.textContent).toContain("cd /home/");
  });

  it("最近命令位于下方，Enter 选择后关闭且不负责执行", async () => {
    mocks.listCommandHistory.mockResolvedValue(latestPage);
    const onSelect = vi.fn();
    render(<CommandHistoryPopover disabled={false} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("pwd"),
      expect.stringContaining("ls -la"),
    ]);
    expect(options.every((option) => option.parentElement === screen.getByRole("listbox"))).toBe(
      true,
    );
    expect(screen.queryByText(/PgUp|PgDn/)).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索历史命令..." }), {
      key: "Enter",
    });

    expect(onSelect).toHaveBeenCalledWith("ls -la");
    expect(screen.queryByRole("textbox", { name: "搜索历史命令..." })).toBeNull();
  });

  it("滚动到顶部增量加载更早命令并保持旧到新顺序", async () => {
    mocks.listCommandHistory
      .mockResolvedValueOnce(latestPage)
      .mockResolvedValueOnce({
        entries: [{ command: "whoami", executedAt: "2026-08-03T00:00:00Z", id: "1" }],
        hasMore: false,
        olderCursor: null,
      });
    render(<CommandHistoryPopover disabled={false} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    await screen.findAllByRole("option");

    fireEvent.scroll(screen.getByRole("listbox"), { target: { scrollTop: 0 } });
    await waitFor(() => expect(mocks.listCommandHistory).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        expect.stringContaining("whoami"),
        expect.stringContaining("pwd"),
        expect.stringContaining("ls -la"),
      ]),
    );
    expect(mocks.listCommandHistory).toHaveBeenLastCalledWith("", "1:2");
  });

  it("鼠标单击选择命令", async () => {
    mocks.listCommandHistory.mockResolvedValue({ ...latestPage, hasMore: false });
    const onSelect = vi.fn();
    render(<CommandHistoryPopover disabled={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    const options = await screen.findAllByRole("option");
    fireEvent.click(options[0]);
    expect(onSelect).toHaveBeenCalledWith("pwd");
  });

  it("打开时显示连接弹窗与按钮的无障碍隐藏三角", async () => {
    mocks.listCommandHistory.mockResolvedValue({ ...latestPage, hasMore: false });
    const { container } = render(
      <CommandHistoryPopover disabled={false} onSelect={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: /历史/ });

    fireEvent.click(trigger);
    await screen.findAllByRole("option");
    const caret = container.querySelector(".command-history-caret");
    expect(caret).not.toBeNull();
    expect(caret?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(trigger);
    expect(container.querySelector(".command-history-caret")).toBeNull();
  });

  it("搜索变化立即丢弃旧请求并在防抖后显示新结果", async () => {
    let resolveInitial: ((page: typeof latestPage) => void) | undefined;
    mocks.listCommandHistory
      .mockImplementationOnce(
        () =>
          new Promise<typeof latestPage>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce({
        entries: [{ command: "git status", executedAt: "2026-08-03T03:00:00Z", id: "4" }],
        hasMore: false,
        olderCursor: null,
      });
    render(<CommandHistoryPopover disabled={false} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    await waitFor(() => expect(mocks.listCommandHistory).toHaveBeenCalledWith(""));

    fireEvent.change(screen.getByRole("textbox", { name: "搜索历史命令..." }), {
      target: { value: "git" },
    });
    resolveInitial?.(latestPage);

    await waitFor(
      () => expect(mocks.listCommandHistory).toHaveBeenLastCalledWith("git"),
      { timeout: 1_000 },
    );
    expect(await screen.findByText("git status")).not.toBeNull();
    expect(screen.queryByText("ls -la")).toBeNull();
  });
});
