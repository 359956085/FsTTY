# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

<!-- release-notes:zh-CN:start -->
### 简体中文

- stdio 与 HTTP 配置生成器新增 dsh（DeepSeek Harness）支持，可生成对应的 profile YAML 补丁。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Added dsh (DeepSeek Harness) to the stdio and HTTP configuration generators, including profile-ready YAML patches.

<!-- release-notes:en-US:end -->

## [1.3.1] - 2026-08-30

<!-- release-notes:zh-CN:start -->
### 简体中文

#### MCP 与安全

- MCP stdio 一键配置改用固定启动脚本和版本化运行时，避免应用更新后 Agent 继续使用被锁定的旧版程序；重新连接 Agent 即可切换到当前运行时。
- 权限数据库 schema 高于 Agent 支持版本时，MCP 权限请求继续安全拒绝，同时不再阻断设置读取和应用更新，并提供版本信息、重新连接及重新一键配置指引。
- 加强 MCP Roots 路径边界、符号链接、命令长度与超时校验；完善审计日志递归脱敏，并停止记录远程命令正文。

#### SSH 与文件管理

- 并发读取远程目录信息和文件列表并优化排序，降低文件管理加载延迟；权限不足时明确显示对应远程账号。
- 改进连接取消与重连，以及终端、设备状态和远程文件异步请求的隔离，避免重复操作或旧结果覆盖当前连接状态。

#### 文件传输与恢复

- 改进上传、下载覆盖冲突的确认与重试流程，避免重复提交、覆盖竞态和旧传输结果污染新连接。
- 增强会话数据持久化恢复，写入异常时保留可信备份，并可从有效临时文件恢复。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### MCP and Security

- Changed MCP stdio one-click configurations to use a fixed launcher and versioned runtimes, preventing agents from continuing to use a locked outdated executable after an app update; reconnecting the agent switches to the current runtime.
- MCP permission requests continue to fail closed when the policy database schema is newer than the agent supports, while Settings and application updates remain available with version details and guidance to reconnect or rerun one-click setup.
- Hardened MCP Roots boundary, symbolic-link, command-length, and timeout validation; expanded recursive audit-log redaction and stopped recording remote command text.

#### SSH and File Management

- Reduced file-manager loading latency by reading remote directory metadata and entries concurrently and optimizing sorting; permission errors now identify the affected remote account.
- Improved connection cancellation and reconnection, plus isolation of asynchronous terminal, device-status, and remote-file requests, preventing duplicate actions and stale results from replacing current connection state.

#### File Transfer and Recovery

- Improved upload and download overwrite-conflict confirmation and retry handling, preventing duplicate submissions, overwrite races, and stale transfer results from affecting a new connection.
- Strengthened session-data recovery so trusted backups are preserved after write failures and valid temporary data can be recovered.

<!-- release-notes:en-US:end -->

## [1.3.0] - 2026-08-10

<!-- release-notes:zh-CN:start -->
### 简体中文

#### 主题

- 新增亮色主题，并支持亮色、暗色和跟随系统三种模式；默认跟随系统。

#### MCP 权限

- 将会话列表与设备状态读取合并到“访问”权限。
- 将文件上传、下载及传输链接独立为“文件传输”权限，可按会话分组单独配置。
- 调整权限显示顺序，使访问范围和高风险操作更清晰。

#### 终端与交互

- 修复终端连接后 Shell Integration 注入命令可能残留在服务器命令历史中的问题。
- 优化设置页首次打开、历史命令焦点恢复、文件管理布局等交互体验。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### Themes

- Added a light theme with Light, Dark, and Follow System modes; Follow System is the default.

#### MCP Permissions

- Merged session discovery and device-status reads into the Access permission.
- Added an independent File Transfer permission for uploads, downloads, and transfer links, configurable per session group.
- Reordered permissions to make access scope and high-risk operations clearer.

#### Terminal and Interaction

- Fixed an issue where Shell Integration commands injected after connecting could remain in the server command history.
- Improved first-open Settings behavior, terminal focus restoration after closing command history, and file-manager layout interactions.

<!-- release-notes:en-US:end -->

## [1.2.2] - 2026-08-09

<!-- release-notes:zh-CN:start -->
### 简体中文

#### 修复

- 修复 MCP 一键配置检测读取异常配置文件时可能导致程序崩溃的问题。
- 修复设置页未随首包加载导致的显示异常。

#### 设置与更新

- 设置页新增下载源选择和更新日志。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### Fixes

- Fixed an issue where reading an invalid configuration file during MCP one-click setup detection could crash the application.
- Fixed a display issue caused by the Settings page not being included in the initial bundle.

#### Settings and Updates

- Added download source selection and update history to Settings.

<!-- release-notes:en-US:end -->

## [1.2.1] - 2026-08-06

<!-- release-notes:zh-CN:start -->
### 简体中文

#### 应用更新

- 修复部分按钮点击无响应的问题。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### Application Updates

- Fixed an issue where some buttons did not respond to clicks.

<!-- release-notes:en-US:end -->

## [1.2.0] - 2026-08-06

<!-- release-notes:zh-CN:start -->
### 简体中文

#### MCP与安全

- 新增 MCP 高级命令管理，可按会话分组精确配置 Agent 允许执行或需要排除的远程命令。

#### 快捷键

- 新增快捷键展示与自定义，支持配置终端复制、粘贴和历史命令相关快捷键。

#### 更新与终端

- 新增国内可用的应用更新下载源。
- 终端支持鼠标拖动选择文本，并在松开后自动复制到系统剪贴板。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### MCP and Security

- Added advanced MCP command management, allowing precise per-session-group control over remote commands that Agents may execute or that must be excluded.

#### Keyboard Shortcuts

- Added shortcut display and customization for terminal copy, paste, and command history actions.

#### Updates and Terminal

- Added an application update download source accessible from mainland China.
- The terminal now copies mouse-dragged text selections to the system clipboard when the mouse button is released.

<!-- release-notes:en-US:end -->

## [1.1.0] - 2026-08-03

<!-- release-notes:zh-CN:start -->
### 简体中文

#### MCP 与 Agent

- 新增本地 Agent 一键设置，支持 Codex、Claude、Cursor、VS Code / GitHub Copilot、Gemini CLI、OpenCode、Trae / Trae CN。

#### 历史命令

- 新增所有会话共享的历史命令，支持搜索、向上加载、去重、JSON 导入导出和清空。
- 历史窗口支持拖动调整宽高。

#### 其他

- 一些样式和交互优化

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### MCP and Agents

- Added one-click local setup for Codex, Claude, Cursor, VS Code / GitHub Copilot, Gemini CLI, OpenCode, Trae / Trae CN.

#### Command History

- Added command history shared by every session, with search, upward loading, deduplication, JSON import/export, and clear.
- The history window supports drag resizing.

#### Other Changes

- Some style and interaction optimizations

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
