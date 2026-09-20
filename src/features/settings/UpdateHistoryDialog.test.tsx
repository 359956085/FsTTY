// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateHistoryDialog } from "./UpdateHistoryDialog";

const locale = vi.hoisted(() => ({ value: "zh-CN" }));
const latestVersionHeadings = ["v1.6.2", "v1.6.0", "v1.5.0"];

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
    expect(screen.getAllByRole("heading", { level: 3 })[0]?.textContent).toBe("v1.6.2");
    expect(screen.queryByText("v1.6.1")).toBeNull();
    expect(screen.getByText("v1.6.0")).toBeTruthy();
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
        "从默认分支手动运行 Windows 发布工作流且 publish=false 时，执行完整的前端、Rust、Broker、桌面和 NSIS 无签名验证构建，无需 Windows 代码签名证书或 Tauri 更新私钥。",
        "无签名安装包会以 UNSIGNED 文件名和独立验证清单上传，仅用于 Windows Sandbox 或虚拟机验收，不生成更新签名、latest.json、GitHub Release 或 CNB Release。",
        "标签推送或 publish=true 继续发布未带 Authenticode 的 Windows 安装包，但强制要求 Tauri 更新私钥、更新签名和 latest.json；正式发布不再读取 PFX 或时间戳配置。",
        "支持从已提权终端启动安装：存在关联普通令牌时，安装完成后以原用户普通权限启动桌面；内置 Administrator 或关闭 UAC 且没有普通令牌时，自动进入管理员兼容模式。",
        "交互安装会在兼容模式继续前说明桌面将保持管理员权限，静默安装会自动继续并写入日志。会话 0、SYSTEM、服务账号、跨会话调用和异常关联令牌仍会被拒绝。",
        "在线更新确认不再显示完整 SID，并会明确说明更新后的桌面权限。",
        "分别提示下载超时、网络、代理、签名、UAC 取消、调用进程退出、身份不一致、部署失败和回滚失败；未知底层错误写入日志，界面显示可操作的通用说明。",
        "应用更新日志新增随机操作 ID、来源、目标版本、阶段、耗时、下载字节数、令牌模式和结果分类，并脱敏代理凭据与完整 SID。",
        "独立安装器新增受 ACL 保护的 ProgramData 日志，普通用户只读并保留 15 天；仓库附带只读令牌与 UAC 诊断脚本。",
        "更新包下载超时调整为 10 分钟，并完善更新公钥一致性验证。",
        "Windows 正式发布新增 Broker、桌面程序和安装包的 Authenticode 签名、时间戳与信任链门禁；任一校验失败都会在上传发布产物前停止。",
      ],
    },
    {
      language: "en-US",
      notes: [
        "Manually running the Windows release workflow from the default branch with publish=false now performs the complete frontend, Rust, broker, desktop, and unsigned NSIS validation build without requiring a Windows code-signing certificate or Tauri updater private key.",
        "The unsigned installer is uploaded with an UNSIGNED filename and a separate validation manifest for Windows Sandbox or virtual-machine testing only. It does not generate an updater signature, latest.json, GitHub Release, or CNB Release.",
        "Tag pushes and publish=true continue to publish Windows installers without Authenticode, while requiring the Tauri updater private key, updater signature, and latest.json. Production releases no longer read PFX or timestamp settings.",
        "Installers can now start from an elevated terminal. When a linked standard token exists, the desktop starts with the original user's standard rights; built-in Administrator and UAC-disabled sessions without a standard token automatically use administrator compatibility mode.",
        "Interactive installs explain that the desktop will retain administrator rights before compatibility mode continues. Silent installs continue automatically and record the mode. Session 0, SYSTEM, service accounts, cross-session callers, and invalid linked tokens remain blocked.",
        "Online update confirmation no longer exposes a full SID and now states the desktop permission level after updating.",
        "Added distinct messages for download timeout, network, proxy, signature, UAC cancellation, caller exit, identity mismatch, deployment failure, and rollback failure. Unknown low-level details go to logs while the interface shows actionable general guidance.",
        "Update logs now include a random operation ID, source, target version, phase, elapsed time, downloaded bytes, token mode, and result category, with proxy credentials and full SIDs redacted.",
        "Standalone installers now write ACL-protected ProgramData logs that are read-only for standard users and retained for 15 days. The repository also includes a read-only token and UAC diagnostic script.",
        "Increased the update-package download timeout to 10 minutes and expanded updater public-key consistency checks.",
        "Production Windows releases now require trusted, timestamped Authenticode signatures on the broker, desktop executable, and installer. Any signature, timestamp, or trust-chain failure stops the release before upload.",
      ],
    },
  ])("$language 展示 v1.6.2 完整说明并保留历史", ({ language, notes }) => {
    locale.value = language;
    render(<UpdateHistoryDialog onClose={vi.fn()} open />);

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .slice(0, 3)
        .map((heading) => heading.textContent),
    ).toEqual(latestVersionHeadings);
    const latest = screen
      .getByRole("heading", { level: 3, name: "v1.6.2" })
      .closest("article");
    if (!latest) {
      throw new Error("缺少 v1.6.2 更新记录");
    }
    const content = within(latest);
    expect(
      content.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(notes);
    expect(content.getByText("2026-09-19")).toBeTruthy();
    expect(screen.queryByText("Unreleased")).toBeNull();
    expect(screen.queryByText("release-notes:zh-CN:start")).toBeNull();
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

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .slice(0, 3)
        .map((heading) => heading.textContent),
    ).toEqual(latestVersionHeadings);
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

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .slice(0, 3)
        .map((heading) => heading.textContent),
    ).toEqual(latestVersionHeadings);
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
