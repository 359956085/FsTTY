// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateHistoryDialog } from "./UpdateHistoryDialog";

const locale = vi.hoisted(() => ({ value: "zh-CN" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: locale.value, resolvedLanguage: locale.value },
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  locale.value = "zh-CN";
});

describe("更新日志弹窗", () => {
  it("展示全部中文正式版本并支持三种关闭方式", () => {
    const onClose = vi.fn();
    render(<UpdateHistoryDialog onClose={onClose} open />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 3 })[0]?.textContent).toBe("v1.6.0");
    expect(screen.getByText("v1.5.0")).toBeTruthy();
    expect(screen.getByText("v1.4.0")).toBeTruthy();
    expect(
      screen.getByText(
        "stdio 与 HTTP 改为独立启停，一键配置只启用对应服务；修复关闭 stdio 后 HTTP 停止且开关无法操作的问题。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("v1.3.1")).toBeTruthy();
    expect(
      screen.getByText(
        "MCP stdio 一键配置改用固定启动脚本和版本化运行时，避免应用更新后 Agent 继续使用被锁定的旧版程序；重新连接 Agent 即可切换到当前运行时。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("v1.3.0")).toBeTruthy();
    expect(
      screen.getByText(
        "新增亮色主题，并支持亮色、暗色和跟随系统三种模式；默认跟随系统。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("v1.2.2")).toBeTruthy();
    expect(
      screen.getByText(
        "修复 MCP 一键配置检测读取异常配置文件时可能导致程序崩溃的问题。",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("修复设置页未随首包加载导致的显示异常。"),
    ).toBeTruthy();
    expect(
      screen.getByText("设置页新增下载源选择和更新日志。"),
    ).toBeTruthy();
    expect(screen.getByText("v1.2.1")).toBeTruthy();
    expect(screen.getByText("修复部分按钮点击无响应的问题。")).toBeTruthy();
    expect(screen.queryByText("Unreleased")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop") as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "sessions.close" })[0]);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      language: "zh-CN",
      notes: [
        "全局代理新增独立启用开关；关闭后保留代理地址但不用于应用外连，重新启用时无需重复填写。",
        "Windows 本地 SSH 凭据服务的状态、管理、迁移、更新及 SSH 数据管道固定通过本机命名管道直连，不使用应用代理、系统代理或环境代理；服务连接远程 SSH 目标时仍遵循已启用的全局代理。",
        "新增独立的终端 ANSI 文字配色，可选择跟随应用主题或 10 套预设：Ayu Mirage、Catppuccin Mocha、Dracula、Everforest Dark、Gruvbox Dark、Kanagawa Wave、Nord、One Half Dark、Rosé Pine、Solarized。",
        "配色选择独立保存并即时更新已打开终端，不重新连接 SSH 或清除屏幕；预设只调整 ANSI 16 色，普通文字、背景、光标和选区继续跟随应用主题。",
        "文件列表新增 Ctrl / Command 追加选择、Shift 连续范围选择，并支持对选中条目批量下载或删除。",
        "批量下载只需选择一次本地目录，所有会话最多同时下载 5 个文件，其余自动排队；覆盖冲突逐项处理，单项失败不阻断其他文件。取消整个批次会停止活动任务且不再启动排队项，轻量模式及界面恢复后继续保留任务状态。",
      ],
    },
    {
      language: "en-US",
      notes: [
        "Added an independent enable switch for the global proxy. Disabling it keeps the saved address without using it for outbound application connections, so it can be re-enabled without entering the address again.",
        "Local Windows SSH credential-service status, administration, migration, update, and SSH data-pipe requests now always connect through the local named pipe without using application, system, or environment proxies. Connections from the service to remote SSH targets still honor the enabled global proxy.",
        "Added independent terminal ANSI text colors with Follow app theme and 10 presets: Ayu Mirage, Catppuccin Mocha, Dracula, Everforest Dark, Gruvbox Dark, Kanagawa Wave, Nord, One Half Dark, Rosé Pine, and Solarized.",
        "The selection persists independently and updates open terminals immediately without reconnecting SSH or clearing the screen. Presets change only the 16 ANSI colors; plain text, background, cursor, and selection continue to follow the app theme.",
        "Added Ctrl / Command additive selection and Shift range selection to the file list, with batch download and delete actions for selected entries.",
        "Batch downloads require choosing the local directory once, run up to five files concurrently across sessions, and queue the rest automatically. Overwrite conflicts are handled per file, and individual failures do not block the remaining files. Canceling the batch stops active transfers and prevents queued files from starting, while lightweight mode and interface restoration preserve task state.",
      ],
    },
  ])("$language 展示 v1.6.0 完整说明并保留历史", ({ language, notes }) => {
    locale.value = language;
    render(<UpdateHistoryDialog onClose={vi.fn()} open />);

    expect(screen.getAllByRole("heading", { level: 3 }).slice(0, 3).map((heading) => heading.textContent))
      .toEqual(["v1.6.0", "v1.5.0", "v1.4.0"]);
    const latest = screen.getByRole("heading", { level: 3, name: "v1.6.0" }).closest("article");
    if (!latest) {
      throw new Error("缺少 v1.6.0 更新记录");
    }
    const content = within(latest);
    expect(content.getAllByRole("listitem").map((item) => item.textContent)).toEqual(notes);
    expect(content.getByText("2026-09-19")).toBeTruthy();
    expect(screen.queryByText("Unreleased")).toBeNull();
    expect(screen.queryByText("release-notes:zh-CN:start")).toBeNull();
  });

  it.each([
    {
      language: "zh-CN",
      notes: [
        "Windows 新增独立 SSH 凭据服务，提高其他应用访问凭据所需权限，防止当前 Windows 账号下未提权恶意程序直接读取已托管的密码、私钥和口令，降低中转站内容注入等攻击引发凭据泄露的风险。",
        "优化 UI、布局与交互体验。",
        "将应用更新中的代理地址移至「常规 → 基础设置」，改为全局代理，统一用于应用外连。",
      ],
      boundary: "保护范围不包含管理员、原私钥文件、剪贴板、未清理旧副本或已授权 MCP 操作；不代表阻止所有注入攻击。",
    },
    {
      language: "en-US",
      notes: [
        "Added an independent SSH credential service on Windows, raising the privileges required for other applications to access credentials and preventing unelevated malware running under the current Windows account from directly reading managed passwords, private keys, and passphrases. This reduces the risk of credential exposure from attacks such as injected content from intermediary services.",
        "Improved the UI, layout, and interaction experience.",
        "Moved the application update proxy address to General → Basic Settings and made it a global proxy for outbound application connections.",
      ],
      boundary: "This protection does not cover administrators, original private-key files, clipboard contents, remaining legacy copies, or authorized MCP operations, and does not prevent all injection attacks.",
    },
  ])("$language 展示 v1.5.0 三项说明与保护边界并保留历史", ({ language, notes, boundary }) => {
    locale.value = language;
    render(<UpdateHistoryDialog onClose={vi.fn()} open />);

    expect(screen.getAllByRole("heading", { level: 3 }).slice(0, 3).map((heading) => heading.textContent))
      .toEqual(["v1.6.0", "v1.5.0", "v1.4.0"]);
    const latest = screen.getByRole("heading", { level: 3, name: "v1.5.0" }).closest("article");
    if (!latest) {
      throw new Error("缺少 v1.5.0 更新记录");
    }
    const content = within(latest);
    expect(content.getAllByRole("listitem").map((item) => item.textContent)).toEqual(notes);
    expect(content.getByText(boundary)).toBeTruthy();
    expect(content.getByText("2026-09-18")).toBeTruthy();
    expect(screen.queryByText("Unreleased")).toBeNull();
    expect(screen.queryByText("release-notes:zh-CN:start")).toBeNull();
  });
});
