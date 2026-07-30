# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

<!-- release-notes:zh-CN:start -->
### 简体中文

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

<!-- release-notes:en-US:end -->

## [1.0.0] - 2026-07-30

<!-- release-notes:zh-CN:start -->
### 简体中文
#### mcp支持
通过mcp工具对ai 能力进行约束，尽可能降低ai直接远程服务器删库的风险。
- 支持stdio 与 HTTP，本地使用开启stdio，远程使用开启http.
- 以会话分组粒度进行权限控制
- 设置中开启mcp服务，复制mcp配置、提示词到agent中使用。
#### 其他
- 应用业务数据统一迁移到 `%APPDATA%\FsTTY`；统一日志输出，保留 15 天。
- 更新弹窗可忽略当前版本。
- 会话列表支持拖动调整分组和会话顺序、跨组移动会话，并可重命名或整组删除分组。
- 远程文件和文件夹支持慢双击行内重命名。
- 会话分组的展开和收起状态记忆。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English
#### MCP Support
MCP tools constrain AI capabilities, reducing the risk of an AI directly performing destructive operations on remote servers.
- Supports stdio and HTTP. Enable stdio for local use and HTTP for remote access.
- Controls permissions at the session-group level.
- Enable the MCP service in Settings, then copy the MCP configuration and prompt into the Agent.
#### Other Changes
- Unified application data under `%APPDATA%\FsTTY`; standardized log output with 15-day retention.
- The update dialog can now ignore the current version.
- The session list now supports drag-and-drop group and session ordering, moving sessions between groups, and renaming or deleting entire groups.
- Remote files and folders can now be renamed inline with a slow double-click.
- Session group expanded and collapsed states are now remembered.

<!-- release-notes:en-US:end -->

## [0.5.0] - 2026-07-24

<!-- release-notes:zh-CN:start -->
### 简体中文

- 设备状态CPU、内存改为折线趋势，新增网络上下行。

- 上传和下载显示实时速度。

- 密码认证时，账号、密码不再是必填项。

- ui、文案、性能优化

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Device Status now displays CPU and memory trend charts and adds real-time network upload and download speeds.

- Uploads and downloads now show real-time transfer speeds.

- Username and password are no longer required for password authentication.

- UI, copy, and performance optimizations.

<!-- release-notes:en-US:end -->

## [0.4.0] - 2026-07-22

<!-- release-notes:zh-CN:start -->
### 简体中文

- 升级到 xterm.js 6，支持 tmux 通过 OSC 52 写入 Windows 剪贴板，并增加可关闭的安全设置。
- 终端支持使用 `Ctrl+C` 将选区复制到 Windows 剪贴板，并使用 `Ctrl+V` 粘贴；
- 修复认证阶段连接中断被误报为密码错误的问题，并对瞬时中断自动重试一次。
- 修复 WebView2 下搜狗输入法按 Shift 切换英文时最终文字未进入终端的问题。
<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Upgraded to xterm.js 6 with tmux OSC 52 clipboard support and an option to disable remote clipboard writes.
- Added `Ctrl+C` for copying terminal selections to the Windows clipboard and `Ctrl+V` for pasting.
- Fixed authentication connection interruptions being reported as invalid passwords, with one automatic retry for transient interruptions.
- Fixed Sogou IME text not reaching the terminal after switching to English with Shift under WebView2.
<!-- release-notes:en-US:end -->
