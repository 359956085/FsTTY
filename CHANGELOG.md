# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

## [1.7.0] - 2026-09-23

<!-- release-notes:zh-CN:start -->
### 简体中文

- 调整亮色主工作区模块的分层配色。
- 修复窗口最小化时的任务栏指示状态。
- 新增官方更新镜像作为下载源。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Refined the layered colors of main workspace modules in the light theme.
- Fixed the taskbar indicator when the window is minimized.
- Added the official update mirror as a download source.

<!-- release-notes:en-US:end -->

## [1.6.2] - 2026-09-19

<!-- release-notes:zh-CN:start -->
### 简体中文

#### Windows 发布验证

- 从默认分支手动运行 Windows 发布工作流且 `publish=false` 时，执行完整的前端、Rust、Broker、桌面和 NSIS 无签名验证构建，无需 Windows 代码签名证书或 Tauri 更新私钥。
- 无签名安装包会以 `UNSIGNED` 文件名和独立验证清单上传，仅用于 Windows Sandbox 或虚拟机验收，不生成更新签名、`latest.json`、GitHub Release 或 CNB Release。
- 标签推送或 `publish=true` 继续发布未带 Authenticode 的 Windows 安装包，但强制要求 Tauri 更新私钥、更新签名和 `latest.json`；正式发布不再读取 PFX 或时间戳配置。

#### Windows 管理员兼容

- 支持从已提权终端启动安装：存在关联普通令牌时，安装完成后以原用户普通权限启动桌面；内置 Administrator 或关闭 UAC 且没有普通令牌时，自动进入管理员兼容模式。
- 交互安装会在兼容模式继续前说明桌面将保持管理员权限，静默安装会自动继续并写入日志。会话 0、SYSTEM、服务账号、跨会话调用和异常关联令牌仍会被拒绝。
- 在线更新确认不再显示完整 SID，并会明确说明更新后的桌面权限。

#### 错误提示与后台诊断

- 分别提示下载超时、网络、代理、签名、UAC 取消、调用进程退出、身份不一致、部署失败和回滚失败；未知底层错误写入日志，界面显示可操作的通用说明。
- 应用更新日志新增随机操作 ID、来源、目标版本、阶段、耗时、下载字节数、令牌模式和结果分类，并脱敏代理凭据与完整 SID。
- 独立安装器新增受 ACL 保护的 ProgramData 日志，普通用户只读并保留 15 天；仓库附带只读令牌与 UAC 诊断脚本。

#### 更新与发布安全

- 更新包下载超时调整为 10 分钟，并完善更新公钥一致性验证。
- Windows 正式发布新增 Broker、桌面程序和安装包的 Authenticode 签名、时间戳与信任链门禁；任一校验失败都会在上传发布产物前停止。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### Windows Release Validation

- Manually running the Windows release workflow from the default branch with `publish=false` now performs the complete frontend, Rust, broker, desktop, and unsigned NSIS validation build without requiring a Windows code-signing certificate or Tauri updater private key.
- The unsigned installer is uploaded with an `UNSIGNED` filename and a separate validation manifest for Windows Sandbox or virtual-machine testing only. It does not generate an updater signature, `latest.json`, GitHub Release, or CNB Release.
- Tag pushes and `publish=true` continue to publish Windows installers without Authenticode, while requiring the Tauri updater private key, updater signature, and `latest.json`. Production releases no longer read PFX or timestamp settings.

#### Windows Administrator Compatibility

- Installers can now start from an elevated terminal. When a linked standard token exists, the desktop starts with the original user's standard rights; built-in Administrator and UAC-disabled sessions without a standard token automatically use administrator compatibility mode.
- Interactive installs explain that the desktop will retain administrator rights before compatibility mode continues. Silent installs continue automatically and record the mode. Session 0, SYSTEM, service accounts, cross-session callers, and invalid linked tokens remain blocked.
- Online update confirmation no longer exposes a full SID and now states the desktop permission level after updating.

#### Errors and Background Diagnostics

- Added distinct messages for download timeout, network, proxy, signature, UAC cancellation, caller exit, identity mismatch, deployment failure, and rollback failure. Unknown low-level details go to logs while the interface shows actionable general guidance.
- Update logs now include a random operation ID, source, target version, phase, elapsed time, downloaded bytes, token mode, and result category, with proxy credentials and full SIDs redacted.
- Standalone installers now write ACL-protected ProgramData logs that are read-only for standard users and retained for 15 days. The repository also includes a read-only token and UAC diagnostic script.

#### Update and Release Security

- Increased the update-package download timeout to 10 minutes and expanded updater public-key consistency checks.
- Production Windows releases now require trusted, timestamped Authenticode signatures on the broker, desktop executable, and installer. Any signature, timestamp, or trust-chain failure stops the release before upload.

<!-- release-notes:en-US:end -->

## [1.6.0] - 2026-09-19

<!-- release-notes:zh-CN:start -->
### 简体中文

#### 代理与凭据服务

- 全局代理新增独立启用开关；关闭后保留代理地址但不用于应用外连，重新启用时无需重复填写。
- Windows 本地 SSH 凭据服务的状态、管理、迁移、更新及 SSH 数据管道固定通过本机命名管道直连，不使用应用代理、系统代理或环境代理；服务连接远程 SSH 目标时仍遵循已启用的全局代理。

#### 终端文字配色

- 新增独立的终端 ANSI 文字配色，可选择跟随应用主题或 10 套预设：Ayu Mirage、Catppuccin Mocha、Dracula、Everforest Dark、Gruvbox Dark、Kanagawa Wave、Nord、One Half Dark、Rosé Pine、Solarized。
- 配色选择独立保存并即时更新已打开终端，不重新连接 SSH 或清除屏幕；预设只调整 ANSI 16 色，普通文字、背景、光标和选区继续跟随应用主题。

#### 文件管理

- 文件列表新增 Ctrl / Command 追加选择、Shift 连续范围选择，并支持对选中条目批量下载或删除。
- 批量下载只需选择一次本地目录，所有会话最多同时下载 5 个文件，其余自动排队；覆盖冲突逐项处理，单项失败不阻断其他文件。取消整个批次会停止活动任务且不再启动排队项，轻量模式及界面恢复后继续保留任务状态。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### Proxy and Credential Service

- Added an independent enable switch for the global proxy. Disabling it keeps the saved address without using it for outbound application connections, so it can be re-enabled without entering the address again.
- Local Windows SSH credential-service status, administration, migration, update, and SSH data-pipe requests now always connect through the local named pipe without using application, system, or environment proxies. Connections from the service to remote SSH targets still honor the enabled global proxy.

#### Terminal Text Colors

- Added independent terminal ANSI text colors with Follow app theme and 10 presets: Ayu Mirage, Catppuccin Mocha, Dracula, Everforest Dark, Gruvbox Dark, Kanagawa Wave, Nord, One Half Dark, Rosé Pine, and Solarized.
- The selection persists independently and updates open terminals immediately without reconnecting SSH or clearing the screen. Presets change only the 16 ANSI colors; plain text, background, cursor, and selection continue to follow the app theme.

#### File Management

- Added Ctrl / Command additive selection and Shift range selection to the file list, with batch download and delete actions for selected entries.
- Batch downloads require choosing the local directory once, run up to five files concurrently across sessions, and queue the rest automatically. Overwrite conflicts are handled per file, and individual failures do not block the remaining files. Canceling the batch stops active transfers and prevents queued files from starting, while lightweight mode and interface restoration preserve task state.

<!-- release-notes:en-US:end -->

## [1.5.0] - 2026-09-18

<!-- release-notes:zh-CN:start -->
### 简体中文

- Windows 新增独立 SSH 凭据服务，提高其他应用访问凭据所需权限，防止当前 Windows 账号下未提权恶意程序直接读取已托管的密码、私钥和口令，降低中转站内容注入等攻击引发凭据泄露的风险。
- 优化 UI、布局与交互体验。
- 将应用更新中的代理地址移至「常规 → 基础设置」，改为全局代理，统一用于应用外连。

保护范围不包含管理员、原私钥文件、剪贴板、未清理旧副本或已授权 MCP 操作；不代表阻止所有注入攻击。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Added an independent SSH credential service on Windows, raising the privileges required for other applications to access credentials and preventing unelevated malware running under the current Windows account from directly reading managed passwords, private keys, and passphrases. This reduces the risk of credential exposure from attacks such as injected content from intermediary services.
- Improved the UI, layout, and interaction experience.
- Moved the application update proxy address to General → Basic Settings and made it a global proxy for outbound application connections.

This protection does not cover administrators, original private-key files, clipboard contents, remaining legacy copies, or authorized MCP operations, and does not prevent all injection attacks.

<!-- release-notes:en-US:end -->

## [1.4.0] - 2026-09-07

<!-- release-notes:zh-CN:start -->
### 简体中文

#### 桌面与后台运行

- 新增 Windows 当前用户开机自启，可在常规设置中独立开启，默认关闭。
- GUI 在普通、最小化、最大化和轻量模式下共用一个主实例；再次启动会唤回已有窗口并保持窗口状态。
- 新增轻量模式，可关闭主界面并保留 SSH 会话、终端程序、后台文件传输和设备状态采样；从托盘或再次启动恢复界面。

#### MCP 配置

- 新增 HTTP 一键配置本地 Agent，自动合并连接配置，并按客户端能力写入或引导粘贴全局提示词；保留其他服务、用户设置及已保存的分组权限。
- stdio 与 HTTP 配置生成器新增 dsh（DeepSeek Harness）支持，可生成对应的 profile YAML 补丁。
- stdio 与 HTTP 改为独立启停，一键配置只启用对应服务；修复关闭 stdio 后 HTTP 停止且开关无法操作的问题。
- 请求按各自传输开关鉴权，并同步已保存的开关状态；完善一键配置提示文案，说明已有旧提示词会替换。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

#### Desktop and Background Operation

- Added optional Windows startup for the current user, controlled independently in General settings and disabled by default.
- Normal, minimized, maximized, and lightweight modes now share one GUI instance; launching FsTTY again restores the existing window while preserving its state.
- Added lightweight mode to close the main interface while keeping SSH sessions, terminal programs, background file transfers, and device sampling active. Restore the interface from the tray or by launching FsTTY again.

#### MCP Configuration

- Added one-click HTTP setup for local Agents, automatically merging connection settings and either writing global instructions or guiding manual paste according to client support, while preserving other servers, user settings, and saved group permissions.
- Added dsh (DeepSeek Harness) to the stdio and HTTP configuration generators, including profile-ready YAML patches.
- Made stdio and HTTP switches independent, with one-click setup enabling only the selected transport. Fixed HTTP stopping and its switch becoming unavailable when stdio was disabled.
- Requests now check their own transport switch and reload saved switch states. Clarified the setup hints to explain replacement of existing FsTTY instructions.

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
