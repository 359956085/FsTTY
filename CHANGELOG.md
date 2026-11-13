# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

## [2.1.0-beta.3] - 2026-11-13

<!-- release-notes:zh-CN:start -->
### 简体中文

- 新增暖陶土、薄荷绿、薰衣草三套浅色主题，覆盖工作区、设置和应用内弹窗；终端沿用原有 ANSI 高亮，切换主题不重建连接或进程。
- 将安装向导首次激活移至欢迎页显示后的延迟回调；Windows 拒绝前台请求时提供有限任务栏提醒，不持续抢夺焦点。
- 调整传输进度框上下间距，字体与终端文字配色下拉框统一宽度。
- 更新 SSH 与系统调用相关安全依赖，保留已有凭据和主机指纹核对流程；既有 RSA 上游阻塞风险继续单独记录。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Added Warm Terracotta, Mint Green, and Lavender light themes for the workspace, settings, and in-app dialogs. Terminals retain existing ANSI colors, connections, and processes when themes change.
- Moved the installer's initial activation to a delayed callback after the welcome page is displayed. If Windows denies foreground activation, the taskbar flashes briefly without repeatedly taking focus.
- Balanced the spacing above and below transfer cards and aligned the font selector width with the terminal color selector.
- Updated security dependencies for SSH and system calls while preserving credential protection and host fingerprint checks. The existing upstream RSA dependency risk remains documented separately.

<!-- release-notes:en-US:end -->

## [2.1.0-beta.2] - 2026-11-11

<!-- release-notes:zh-CN:start -->
### 简体中文

- 调整常规设置中的字体排列、选项名称和字号说明，收紧字体下拉框。
- 终端字体放大、缩小支持自定义键盘或滚轮绑定，可分别清除和恢复默认；所有终端共用字号设置并自动保存。
- 收紧终端右侧留白，文件管理展开按钮与滚动条保持间隔，避免相互遮挡。
- 批量上传、下载显示扫描后的总文件数和总目录数，修复下载状态文字重叠；窄面板支持状态文字换行。
- 改进 UAC 授权后安装向导的首次激活；未获得前台时提供任务栏提醒。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Refined the order of font settings, font option labels, and font size guidance, and made the font selector more compact.
- Terminal font size increase and decrease actions support custom keyboard or wheel bindings, with individual clearing and default restoration. All terminals share the font size and save changes automatically.
- Reduced the terminal's right padding and separated the file panel expand button from the scrollbar to prevent overlap.
- Batch uploads and downloads show total file and folder counts after scanning. Fixed overlapping download status text and enabled wrapping in narrow panels.
- Improved initial installer wizard activation after UAC approval, with a taskbar notification when the wizard does not gain foreground focus.

<!-- release-notes:en-US:end -->

## [2.1.0-beta.1] - 2026-11-11

<!-- release-notes:zh-CN:start -->
### 简体中文

- 终端列表支持双击或按 Enter／空格，新建独立标签并立即连接 SSH 或启动 CMD、PowerShell、Git Bash；单击不启动，拖动排序后的点击不会误开标签。
- 新增全局字体选择，内置 JetBrains Mono；支持终端字号设置及 Ctrl＋滚轮调整，现有终端即时更新并保存设置。
- SSH 文件管理支持文件／文件夹混选上传、文件夹下载及批量权限修改。目录传输保留层级、隐藏文件和空目录，支持目录合并、冲突保护及取消；递归权限可分别设置文件和文件夹，并可在轻量模式后接回任务。
- 更新部分安全依赖及构建工具，保留原有功能和已记录的上游依赖风险说明。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Double-click a terminal list item or press Enter or Space to open an independent tab and immediately connect to SSH or start CMD, PowerShell, or Git Bash. Single clicks do not start terminals, and clicks following a drag do not accidentally open tabs.
- Added a global font selector with bundled JetBrains Mono, plus terminal font size settings and Ctrl+wheel adjustment. Existing terminals update immediately and preferences are saved.
- SSH file management supports mixed file and folder uploads, folder downloads, and batch permission changes. Directory transfers preserve structure, hidden files, and empty folders, with directory merging, conflict protection, and cancellation. Recursive permissions can be set separately for files and folders, and tasks can be reattached after lightweight mode.
- Updated selected security dependencies and build tools while preserving existing behavior and documented upstream dependency risk notes.

<!-- release-notes:en-US:end -->

## [2.0.2] - 2026-11-07

<!-- release-notes:zh-CN:start -->
### 简体中文

- STDIO 和 Streamable HTTP 支持 MCP `2026-07-28` 的服务器发现与逐请求元数据，继续兼容旧版握手与工具响应。新版客户端可获取准确的工具列表缓存提示和机器可读的业务错误。
- 新版 STDIO 文件传输支持一次性 Roots 续调，校验请求状态、参数、会话权限和本地路径。两种传输均限制工具调用频率，HTTP 未认证请求提供标准 Bearer 认证挑战。
- 优化 SSH 主机指纹变化提示，可在编辑终端时打开核对窗口、对照新旧指纹。确认新指纹后可继续使用已保存的凭据。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- STDIO and Streamable HTTP support server discovery and per-request metadata in MCP `2026-07-28` while retaining compatibility with legacy handshakes and tool responses. New clients receive tool list cache hints and machine-readable errors for failed operations.
- File transfers over modern STDIO support one-time Roots continuations with checks for request state, arguments, session permissions, and local paths. Both transports rate-limit tool calls, and unauthenticated HTTP requests receive a standard Bearer challenge.
- Improved SSH host fingerprint warnings and added clearer guidance for comparing old and new fingerprints from the terminal editor. Saved credentials can be reused after confirming the new fingerprint.

<!-- release-notes:en-US:end -->

## [2.0.2-beta.1] - 2026-11-06

<!-- release-notes:zh-CN:start -->
### 简体中文

- STDIO 和 Streamable HTTP 支持 MCP `2026-07-28` 的服务器发现与逐请求元数据，继续兼容旧版握手与工具响应。新版客户端可获取准确的工具列表缓存提示和机器可读的业务错误。
- 新版 STDIO 文件传输支持一次性 Roots 续调，校验请求状态、参数、会话权限和本地路径。两种传输均限制工具调用频率，HTTP 未认证请求提供标准 Bearer 认证挑战。
- 优化 SSH 主机指纹变化提示，可在编辑终端时打开核对窗口、对照新旧指纹。确认新指纹后可继续使用已保存的凭据。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- STDIO and Streamable HTTP support server discovery and per-request metadata in MCP `2026-07-28` while retaining compatibility with legacy handshakes and tool responses. New clients receive tool list cache hints and machine-readable errors for failed operations.
- File transfers over modern STDIO support one-time Roots continuations with checks for request state, arguments, session permissions, and local paths. Both transports rate-limit tool calls, and unauthenticated HTTP requests receive a standard Bearer challenge.
- Improved SSH host fingerprint warnings and added clearer guidance for comparing old and new fingerprints from the terminal editor. Saved credentials can be reused after confirming the new fingerprint.

<!-- release-notes:en-US:end -->

## [2.0.1] - 2026-11-05

<!-- release-notes:zh-CN:start -->
### 简体中文

- CMD、PowerShell 和 Git Bash 的原生历史可在停止终端或重启应用后继续查询，按终端配置和实际权限隔离。新提交的单行命令可在全局历史中搜索并填入终端，继续沿用原生历史过滤。
- 统一本地终端未运行与 SSH 未连接时的居中提示和操作布局。悬停或聚焦标签可查看完整终端名称，收紧文件面板与终端之间的间距。
- Windows 安装器会持续等待关闭旧版 FsTTY 的确认，并在确认后重新核实待退出的进程。安装失败时提供更具体的阶段和诊断信息。
- 简化 STDIO 和 Streamable HTTP 的 MCP 工具参数 schema，提高对严格校验客户端的兼容性。握手明确声明工具列表固定，两个传输各自列出支持的文件传输工具。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Native CMD, PowerShell, and Git Bash history persists across terminal stops and app restarts and is isolated by terminal configuration and verified privilege. Newly submitted single-line commands can be searched and inserted from global history, with native history filters respected.
- Aligned the centered status and action layout for stopped local terminals and disconnected SSH tabs. Tabs show their full terminal names on hover or focus. Reduced the spacing between the file panel and terminal.
- The Windows installer waits for confirmation to close the old FsTTY instance and checks again which processes need to exit after confirmation. Installation failures provide more specific diagnostics.
- Simplified MCP tool input schemas for STDIO and Streamable HTTP to improve compatibility with strict clients. The handshake declares a fixed tool list, and each transport lists the file transfer tools it supports.

<!-- release-notes:en-US:end -->

## [2.0.1-beta.2] - 2026-10-15

<!-- release-notes:zh-CN:start -->
### 简体中文

- 安装关闭旧 FsTTY 的确认弹窗不再受外层部署超时限制，未操作时持续等待用户选择。
- 安装确认后重新核实旧进程，再请求全部结束并等待，避免使用等待期间过时的进程列表；已退出的进程不再误报失败，无法核实或实际未退出仍阻止替换。
- 细化安装失败阶段、进程与系统错误日志，提示退出旧程序后重试，并兼容 beta 版本安装验收。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Removed the outer deployment timeout while the installer waits for confirmation to close FsTTY; the dialog waits until the user chooses.
- Recheck old processes after installation confirmation before requesting all terminations and waiting, avoiding a stale process list during the user's decision. Already exited processes are accepted; unverified or still-running processes block replacement.
- Added clearer installer failure stages and process/system diagnostics, retry guidance, and beta-compatible installation validation.

<!-- release-notes:en-US:end -->

## [2.0.1-beta.1] - 2026-10-15

<!-- release-notes:zh-CN:start -->
### 简体中文

- CMD、PowerShell、Git Bash 新增按终端配置和实际权限隔离的原生历史持久保存，停止终端或重启应用后可继续查询。
- 三种本地终端接入全局命令历史，共享搜索、去重和手动填入功能，保留原生历史过滤；仅采集新提交的单行命令，不导入旧历史。
- 统一本地终端与 SSH 的未运行提示和启动入口，使用居中布局并保留状态、输出及焦点行为。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Added persistent native CMD, PowerShell, and Git Bash history, isolated by terminal configuration and verified privilege, across terminal stops and app restarts.
- Connected local terminals to global command history with shared search, deduplication, and manual insertion while preserving native filters. Only newly submitted single-line commands are collected; existing history is not imported.
- Aligned local terminal idle messages and launch controls with the centered SSH layout while preserving state, output, and focus behavior.

<!-- release-notes:en-US:end -->

## [2.0.0] - 2026-10-09

<!-- release-notes:zh-CN:start -->
### 简体中文

- 新增 CMD、PowerShell 和 Git Bash 本地终端，支持普通与管理员权限启动；统一新建表单，并沿用会话分组与多标签交互。
- CMD、PowerShell 支持输入命令和明确的错误、警告、目录输出高亮，颜色沿用终端文字配色；修复切换标签和调整尺寸后的历史高亮保留。
- 优化弹窗、右键菜单、文件与分组操作的键盘导航和焦点恢复，统一会话类型图标、标签状态及侧栏衔接，并增加可配置的工作区快捷键。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Added local CMD, PowerShell, and Git Bash terminals with standard or administrator launch options, unified creation forms, session groups, and multiple tabs.
- Added command input and explicit error, warning, and directory output highlighting for CMD and PowerShell using the selected terminal palette; fixed historical highlights disappearing after tab switches or resizing.
- Improved keyboard navigation and focus restoration in dialogs, context menus, file and group operations; unified session icons, tab states, and sidebar alignment, and added configurable workspace shortcuts.

<!-- release-notes:en-US:end -->

## [1.7.2] - 2026-09-23

<!-- release-notes:zh-CN:start -->
### 简体中文

- 修复 Windows 安装器初始化时误判暂存目录已存在、导致安装无法继续的问题。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Fixed a Windows installer initialization error that incorrectly reported an existing staging directory and prevented installation.

<!-- release-notes:en-US:end -->

## [1.7.1] - 2026-09-23

<!-- release-notes:zh-CN:start -->
### 简体中文

- 修复自动更新期间旧程序提前退出导致安装中止的问题。
- 自动更新现在会关闭旧程序并启动新版，不再弹出安装向导或要求手动重启。
- 修复更新失败后暂存票据未及时释放的问题，改进重试提示和安装日志。

<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
### English

- Fixed an update failure caused by the old app exiting before deployment.
- Automatic updates now close the old app and launch the new version without an installer wizard or manual restart.
- Fixed staged update tickets remaining locked after a failed attempt and improved retry messages and installation logs.

<!-- release-notes:en-US:end -->

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
- 无签名安装包会以 `UNSIGNED` 文件名和独立验证清单上传，仅用于 Windows Sandbox 或虚拟机验收，不生成更新签名、`latest.json`或 GitHub Release。
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
- The unsigned installer is uploaded with an `UNSIGNED` filename and a separate validation manifest for Windows Sandbox or virtual-machine testing only. It does not generate an updater signature, `latest.json`, or GitHub Release.
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
