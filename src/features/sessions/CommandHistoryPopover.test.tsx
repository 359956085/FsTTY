// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandHistoryPopover,
  type CommandHistoryPopoverHandle,
} from "./CommandHistoryPopover";

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
    "sessions.resizeCommandHistoryHeight": "调整历史命令列表高度",
    "sessions.resizeCommandHistoryWidth": "调整历史命令列表宽度",
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
  window.localStorage.clear();
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
  it("历史搜索快捷键打开并聚焦，历史列表快捷键关闭", async () => {
    mocks.listCommandHistory.mockResolvedValue({ ...latestPage, hasMore: false });
    const ref = createRef<CommandHistoryPopoverHandle>();
    render(<CommandHistoryPopover disabled={false} onSelect={vi.fn()} ref={ref} />);
    expect(screen.getByRole("button", { name: /历史/ }).title).toContain("Ctrl+Shift+H");

    act(() => ref.current?.focusSearch());
    const search = await screen.findByRole("textbox", { name: "搜索历史命令..." });
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("placeholder")).toContain("Ctrl+F");

    fireEvent.keyDown(search, {
      code: "KeyH",
      ctrlKey: true,
      key: "H",
      shiftKey: true,
    });
    expect(screen.queryByRole("textbox", { name: "搜索历史命令..." })).toBeNull();
  });

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
    expect(list.parentElement?.classList.contains("command-history-list-frame")).toBe(true);
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

  it("仅按钮关闭时请求恢复终端焦点", async () => {
    mocks.listCommandHistory.mockResolvedValue({ ...latestPage, hasMore: false });
    const onTriggerClose = vi.fn();
    render(
      <CommandHistoryPopover
        disabled={false}
        onSelect={vi.fn()}
        onTriggerClose={onTriggerClose}
      />,
    );
    const trigger = screen.getByRole("button", { name: /历史/ });

    fireEvent.click(trigger);
    await screen.findAllByRole("option");
    fireEvent.click(trigger);
    expect(onTriggerClose).toHaveBeenCalledOnce();

    fireEvent.click(trigger);
    await screen.findAllByRole("option");
    fireEvent.pointerDown(document.body);
    expect(onTriggerClose).toHaveBeenCalledOnce();
  });

  it("顶部、右侧和右上角分别调整尺寸并永久保存", async () => {
    mocks.listCommandHistory.mockResolvedValue({ ...latestPage, hasMore: false });
    const { container } = render(
      <CommandHistoryPopover disabled={false} onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    await screen.findAllByRole("option");

    const root = container.querySelector<HTMLElement>(".command-history-control")!;
    const popover = container.querySelector<HTMLElement>(".command-history-popover")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(createRect(0, 500, 600, 34));
    vi.spyOn(popover, "getBoundingClientRect").mockImplementation(() =>
      createRect(
        0,
        192,
        Number.parseFloat(popover.style.width) || 400,
        Number.parseFloat(popover.style.height) || 300,
      ),
    );
    fireEvent.resize(window);
    await waitFor(() => expect(popover.style.maxWidth).toBe("600px"));

    const top = screen.getByRole("separator", { name: "调整历史命令列表高度" });
    fireEvent.pointerDown(top, { button: 0, clientX: 200, clientY: 192, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 152, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(popover.style.width).toBe("400px");
    expect(popover.style.height).toBe("340px");

    const right = screen.getByRole("separator", { name: "调整历史命令列表宽度" });
    fireEvent.pointerDown(right, { button: 0, clientX: 400, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 450, clientY: 300, pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(popover.style.width).toBe("450px");
    expect(popover.style.height).toBe("340px");

    const corner = container.querySelector<HTMLElement>(".command-history-resizer-corner")!;
    expect(corner.getAttribute("aria-hidden")).toBe("true");
    fireEvent.pointerDown(corner, { button: 0, clientX: 450, clientY: 152, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 480, clientY: 132, pointerId: 3 });
    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(popover.style.width).toBe("480px");
    expect(popover.style.height).toBe("360px");

    expect(JSON.parse(window.localStorage.getItem("fstty.workspace.v1") ?? "{}")).toMatchObject({
      commandHistoryPopover: { width: 480, height: 360 },
    });
  });

  it("键盘缩放遵守最小尺寸", async () => {
    window.localStorage.setItem(
      "fstty.workspace.v1",
      JSON.stringify({ commandHistoryPopover: { width: 220, height: 180 } }),
    );
    mocks.listCommandHistory.mockResolvedValue({ ...latestPage, hasMore: false });
    const { container } = render(
      <CommandHistoryPopover disabled={false} onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    await screen.findAllByRole("option");
    const root = container.querySelector<HTMLElement>(".command-history-control")!;
    const popover = container.querySelector<HTMLElement>(".command-history-popover")!;
    const hints = container.querySelector<HTMLElement>(".command-history-hints")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(createRect(0, 500, 600, 34));
    vi.spyOn(popover, "getBoundingClientRect").mockReturnValue(createRect(0, 312, 220, 180));
    hints.style.gap = "18px";
    hints.style.padding = "0 10px";
    [64, 72, 52].forEach((width, index) => {
      vi.spyOn(hints.children[index], "getBoundingClientRect").mockReturnValue(
        createRect(0, 0, width, 12),
      );
    });
    fireEvent.resize(window);
    await waitFor(() => expect(popover.style.maxWidth).toBe("600px"));
    await waitFor(() => expect(popover.style.minWidth).toBe("246px"));

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "调整历史命令列表宽度" }),
      { key: "ArrowLeft" },
    );
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "调整历史命令列表高度" }),
      { key: "ArrowDown" },
    );
    expect(popover.style.width).toBe("246px");
    expect(popover.style.height).toBe("180px");
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

function createRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
