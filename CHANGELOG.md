# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

<!-- release-notes:zh-CN:start -->
### 简体中文

- MCP 远程大文件条件读取支持前后各 50 行上下文，并将单次响应严格限制为 8 MiB；截断后可继续分页扫描。
- MCP 设置页重构为 stdio、HTTP 和权限三张卡片；配置与令牌操作改为图标按钮，端口支持失焦或回车保存，权限仅在修改后可保存。
- 拆分 MCP 服务与权限反馈，服务开关成功后静默保存，失败信息显示在服务卡片；“刷新令牌”改为“重置令牌”。
- 新增本地 MCP 服务，支持 stdio 与带令牌的 Streamable HTTP；可按会话分组授权状态读取、文件读取、命令、编辑和删除能力。
- 更新弹窗支持忽略当前版本；自动检查不再提示已忽略版本，手动检查仍可查看并安装。
- 会话列表支持拖动调整分组和会话顺序、跨组移动会话，并可重命名或整组删除分组。
- 远程文件和文件夹支持慢双击行内重命名，并修复拖动捕获导致点击无法识别的问题。
- 会话分组的展开和收起状态会在应用重启后恢复。
- 修复 MCP 分组权限保存失败，并避免仅修改权限时重启本地 HTTP 服务。
- MCP stdio 与 HTTP 分组权限支持热加载，保存后对新请求立即生效，无需重连；权限文件异常时拒绝后续请求。
- MCP HTTP 新增 5 分钟有效的上传、下载链接，支持浏览器选择文件、原始 PUT、单区间断点续传和严格不覆盖上传。
- MCP 新增权限引导工具，可按当前界面语言返回目标工具所需权限和设置步骤，且不会暴露未授权分组。
- 简化 MCP 设置页的 stdio、HTTP 服务、权限及令牌操作文案。
- MCP 权限表增加即时工具提示，可直接查看每项权限对应的工具，并移除问号光标。
- 设置页新增常规与 MCP 左侧导航；MCP 服务和权限分区展示，并可按 Agent 生成 stdio 或 HTTP 配置。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- MCP conditional reads of large remote files now support up to 50 context lines on each side and strictly limit each response to 8 MiB, with resumable scanning after truncation.
- Refactored MCP settings into separate stdio, HTTP, and Permissions cards, with icon-only config and token actions, port saving on blur or Enter, and permission saving enabled only when changed.
- Separated MCP service and permission feedback. Service toggles now save silently on success and show failures in the service card; “Refresh token” is now “Reset token”.
- Added a local MCP server with stdio and token-protected Streamable HTTP transports, plus per-group permissions for status reads, file reads, commands, edits, and deletion.
- The update dialog can now ignore the current version. Automatic checks suppress ignored versions, while manual checks can still show and install them.
- The session list now supports drag-and-drop group and session ordering, moving sessions between groups, and renaming or deleting entire groups.
- Remote files and folders can now be renamed inline with a slow double-click, including when pointer capture is active for dragging.
- Session group expanded and collapsed states are now restored after restarting the app.
- Fixed MCP group permissions failing to persist and avoided restarting the local HTTP server for permission-only changes.
- MCP stdio and HTTP group permissions now hot-reload for new requests without reconnecting, and subsequent requests fail closed when permission settings are unavailable or invalid.
- MCP HTTP now provides five-minute upload and download links with a browser file picker, raw PUT uploads, single-range resume support, and strict no-overwrite uploads.
- MCP now provides a permission guide tool that returns the required permission and setup steps in the current UI language without exposing unauthorized groups.
- Simplified the stdio, HTTP service, permissions, and token action copy on the MCP settings page.
- Added instant tooltips to the MCP permission table showing the tools covered by each permission, without a help cursor.
- Added General and MCP navigation to Settings, split MCP services from permissions, and added Agent-specific stdio and HTTP config generation.

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
