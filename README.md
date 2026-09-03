<img src="./src/assets/brand-icon.png" width="96" alt="FsTTY 图标">

# FsTTY

面向 AI Agent 的 Windows SSH 与 MCP 安全操作台。

**简体中文** | [English](README.en-US.md)

[![最新版本](https://img.shields.io/github/v/release/359956085/FsTTY?display_name=tag&label=release)](https://github.com/359956085/FsTTY/releases/latest)
![Version](https://img.shields.io/badge/version-1.3.1-2563EB)
![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
[![MIT License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![FsTTY MCP 设置](./doc/assets/fstty-setting-mcp.png)

## 为什么使用 FsTTY MCP

FsTTY 把已经保存的 SSH 会话安全地开放给 Codex、Claude、Cursor 等 Agent。Agent 不接触密码和私钥，只能在用户授权的会话分组中调用明确的工具。

- **最小权限**：按会话分组分别控制访问、文件读取、文件传输、命令、编辑和删除。
- **复用 SSH 能力**：终端、SFTP、主机密钥校验和系统凭据库由 FsTTY 统一处理。
- **本地与远程接入**：支持本机 stdio，以及可信局域网或 VPN 内的 Streamable HTTP。
- **一键配置 Agent**：自动检测本机 Agent，支持 stdio 或本地 HTTP，合并 MCP 配置和全局提示词，不覆盖无关设置。
- **适合生产排障**：支持远程日志搜索、分段读取、命令执行、原子写入和受控文件传输。
- **可审计**：独立记录工具、会话、结果和耗时；可选记录脱敏后的工具输入。

## MCP 工具

FsTTY 目前提供 17 个 MCP 工具：

| 权限 | 工具 | 能力 |
| --- | --- | --- |
| 无需会话权限 | `get_permission_guide` | 返回目标工具所需权限和当前界面的设置步骤 |
| 访问 | `list_sessions`、`get_device_status` | 发现已授权会话；读取 CPU、内存、磁盘、网络、系统和运行时间；也是所有工具的前置权限 |
| 文件读取 | `list_remote_files`、`read_remote_file`、`search_remote_file` | 浏览目录、分段读取文件、按关键词扫描远程日志 |
| 文件传输 | `upload_local_file`、`download_remote_file`、`create_remote_file_upload_link`、`create_remote_file_download_link` | 通过 stdio Roots 或五分钟有效链接上传、下载文件 |
| 编辑 | `write_remote_file`、`create_remote_directory`、`rename_remote_entry`、`move_remote_entry` | 原子写入文件；创建、重命名和移动远程条目 |
| 删除 | `delete_remote_entry` | 递归删除远程文件或目录 |
| 命令 | `get_command_policy`、`execute_command` | 查询当前高级命令策略，并在已授权会话中执行远程 Shell 命令 |

`search_remote_file` 单次最多扫描 `16 MiB`，响应限制为 `8 MiB`，可携带前后各 `0–50` 行上下文，并通过 `nextOffset` 继续扫描。适合搜索大日志，无需先读取完整文件。

## 权限与安全边界

新会话分组默认未向 MCP 开放。启用分组访问后即可发现会话并读取设备状态；文件读取默认开启，文件传输、命令、编辑和删除默认关闭。

- 权限保存后对下一次 stdio 或 HTTP 请求立即生效，无需重连。
- 命令权限可能绕过编辑和删除限制，只应授予可信 Agent。
- FsTTY MCP 工具不会返回密码、私钥正文、私钥口令或 HTTP Bearer Token。
- 首次出现或发生变化的主机密钥必须先在 FsTTY 界面核对并确认。
- 文件写入采用临时文件和原子替换；上传、重命名和移动不会覆盖已有目标。
- 删除没有回收站，FsTTY 会在工具描述中将其标记为破坏性操作。
- 权限配置无法读取或校验失败时，请求默认拒绝。

## stdio 与 HTTP

| | stdio | Streamable HTTP |
| --- | --- | --- |
| 场景 | 本机 Agent | 本机、可信局域网或 VPN 内的 Agent |
| 地址 | `cmd.exe` 调用应用数据目录中的固定 MCP 启动脚本 | `http://<FSTTY_HOST_IP>:37653/mcp`（默认端口） |
| 认证 | 本地进程通信 | Windows 凭据库中的 Bearer Token |
| 本地文件传输 | 使用 MCP 客户端 Roots | 使用 5 分钟传输链接 |
| 网络暴露 | 无监听端口 | 监听所有 IPv4 接口，明文传输 |

stdio 本地配置固定指向 `mcp-runtime/fstty-mcp.cmd`；脚本会从原子更新的版本指针启动当前 FsTTY MCP 运行时，因此应用更新后只需重新连接 Agent。

HTTP 的“一键本地配置”写入 `http://127.0.0.1:<已保存端口>/mcp`，不准备或启动独立 stdio 运行时。FsTTY 必须保持运行，轻量模式同样可用。

HTTP 禁止暴露到公网。`/mcp` 面向原生 MCP 客户端，拒绝带 `Origin` 的请求，不支持浏览器 MCP 客户端或 CORS。

传输链接本身即凭据，不再要求 Bearer Token。下载支持单区间断点续传；上传首次成功后立即失效，并且绝不覆盖已有远程文件。

## GUI 全模式单实例

同一登录会话内，普通、最小化、最大化和轻量模式共用一个 GUI 主实例。再次启动 FsTTY 会唤回已有窗口；最小化窗口先还原，最大化窗口保持最大化，轻量模式重建主窗口并恢复原有会话。不会启动第二套托盘或 MCP HTTP 服务。

`--mcp-stdio` 仍按客户端独立运行，不受 GUI 单实例限制；WebView2 也可能产生多个系统进程。单实例不等于任务管理器中只有一个进程，不会自动结束旧版本进程。

## 开机自启

在“设置 → 常规 → 通用设置”开启“开机自启”，当前 Windows 用户登录后启动 FsTTY，默认关闭。普通模式显示主窗口；上次处于轻量模式时仅显示托盘。沿用 GUI 单实例检查，不自动重连 SSH，也不另行启动 MCP stdio 进程。

开关直接读取系统登记，不在应用配置中重复保存。加载和保存期间禁止重复操作；返回设置页或窗口重新获得焦点时刷新，失败可重新读取或重试。自启与 HTTP 一键配置独立控制，不创建系统服务或计划任务。

## 轻量模式

点击标题栏最小化按钮左侧的叶子按钮，可关闭主 WebView，保留同一进程中的 SSH、终端程序和后台上传下载。首次进入需确认，可选择“不再提示”。从托盘“显示主窗口”或再次启动 FsTTY 恢复界面；普通关闭按钮仍退出程序。

CPU、内存曲线在轻量期间继续采样，恢复后显示最近 10 分钟。每个 GUI 连接独立保存最多 121 条样本；数据只在内存中保留，断开连接或退出进程后清除。后台沿用约 5 秒一轮的设备采集，会继续产生少量 SSH 请求。

轻量开关跨进程重启保留，SSH、Vim 和传输本身不跨进程保活。终端快照仅保存在内存；缓存达到上限时截断旧历史，保留当前画面。详见[实现边界与 Windows 验收清单](doc/lightweight-mode.md)。

## 快速开始

1. 从 [CNB Releases（国内）](https://cnb.cool/359956085/FsTTY/-/releases) 或 [GitHub Releases](https://github.com/359956085/FsTTY/releases/latest) 安装 FsTTY。
2. 创建 SSH 会话并完成首次主机密钥确认。
3. 打开“设置 → MCP”。
4. 在“权限”中开启需要暴露的会话分组，并按需授权工具类别。
5. 点击 stdio 区域的“一键设置”，或 HTTP 区域的“一键本地配置”，选择本机 Agent 并完成配置；所需 MCP 开关会自动启用。
6. 让 Agent 先调用 `list_sessions`，再按返回的会话 ID 使用其他工具。

也可以分别复制 stdio 或 HTTP 配置，以及 Agent 使用提示词，手工粘贴到其他 MCP 客户端。

复制配置支持 dsh（DeepSeek Harness）。使用前请在目标 profile 安装兼容版本的
`@deepseek-ai/dsh-mcp-client`，再将生成的 YAML 追加到
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`；本机 HTTP 连接可将
`<FSTTY_HOST_IP>` 替换为 `127.0.0.1`。

## 一键配置本地 Agent

| Agent | MCP 配置 | 全局提示词 |
| --- | --- | --- |
| Codex | 自动合并 | 自动合并 `AGENTS.md` |
| Claude Code | stdio 使用官方 CLI；HTTP 直接合并用户级 `.claude.json` | 自动合并 `CLAUDE.md` |
| Cursor | 自动合并 | 复制后手工粘贴到 User Rules |
| VS Code / GitHub Copilot | 自动合并默认用户 Profile | 写入独立 instructions 文件 |
| Gemini CLI | 自动合并 | 自动合并 `GEMINI.md` |
| OpenCode | 保留 JSONC 注释并自动合并 | 自动合并 `AGENTS.md` |
| Trae | 自动合并 | 复制后手工粘贴到 User Rules |
| Trae CN | 自动合并 | 复制后手工粘贴到 User Rules |

自动配置只替换所选客户端的同名 `fstty` 节点及 `fstty:begin/end` 提示词标记区块，清除旧传输字段，保留其他服务和用户设置。配置损坏、未知结构、OpenCode 双配置冲突或检测到外部修改时拒绝覆盖；原子提交失败保留原文件并清理临时文件。单项失败不会回滚其他成功项，重复运行不会重复追加内容。

HTTP 弹窗打开时只检测；点击配置后先确认端口保存成功，再启用 MCP 总开关和 HTTP，确认监听成功后才写客户端文件。沿用已保存权限，不扩大访问范围。端口、Token 和本地配置写入串行处理，关闭窗口不会提前释放正在写入的事务锁。

Windows HTTP 监听启用端口独占，避免回环地址已有其他监听时误判启动成功；仍监听所有 IPv4 接口。参照 [Microsoft 套接字独占说明](https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse)。

HTTP 配置会把 Bearer Token 保存在第三方客户端配置文件中。令牌由 Rust 获取和写入，不通过一键配置的 IPC 结果、命令行、日志或剪贴板传递；Claude HTTP 不调用携带凭据的 CLI。配置格式遵循 [Codex MCP 配置](https://developers.openai.com/codex/mcp/)和 [Claude Code HTTP 配置](https://code.claude.com/docs/en/mcp)。

成功后重载客户端。后续修改端口或轮换 Token，需要重新执行一键配置；不会自动终止已有 stdio 进程，也不会开启开机自启。“本地配置”仅指客户端使用回环地址，HTTP 仍监听所有 IPv4 接口，不自动修改防火墙；不要暴露到公网。

## MCP 审计日志

审计日志独立保存在 `%APPDATA%\FsTTY\logs\mcp-audit-YYYY-MM-DD.log`，最多保留 15 天。

- 基础记录包含传输方式、工具、会话、结果和耗时。
- “设置 → 常规 → 日志 → 记录 MCP 工具输入”默认关闭，可实时开启。
- 开启后记录命令、路径等工具参数，但不记录工具输出、请求头、Token 或传输正文。
- `write_remote_file.content` 仅记录 UTF-8 字节数和 SHA-256；正文不会写入日志。
- 每条记录使用单行常规日志格式，字符串和控制字符会安全转义。

## Windows SSH 工作区

MCP 之外，FsTTY 也是完整的 Windows SSH 客户端。

![FsTTY 会话工作区](./doc/assets/fstty-overview.png)

| 功能 | 说明 |
| --- | --- |
| 会话管理 | 分组、拖动排序、跨组移动、搜索、收藏和多标签页 |
| SSH 认证 | 密码、私钥文件和粘贴私钥正文；敏感凭据保存到系统凭据库 |
| 远程终端 | xterm.js 6、复制粘贴、清屏、重连、tmux 鼠标和 OSC 52 剪贴板 |
| 历史命令 | 所有会话共享、搜索、向上加载、去重、JSON 导入导出和清空；支持 Bash、Zsh 自动采集 |
| 文件管理 | SFTP 浏览、上传、下载、拖放移动、新建目录、重命名、复制路径和递归删除 |
| 设备状态 | CPU、内存趋势、磁盘、网络上下行、操作系统和运行时间 |
| 自动更新 | CNB/GitHub 并发检查、版本忽略、Markdown 更新说明和更新代理 |

历史命令的 Enter 或鼠标单击只会把命令放入终端，不会自动执行。历史窗口支持搜索、键盘选择和拖动调整宽高。

## 下载与安装

优先前往 [CNB Releases（国内）](https://cnb.cool/359956085/FsTTY/-/releases)，也可使用 [GitHub Releases](https://github.com/359956085/FsTTY/releases/latest) 下载 Windows x64 安装包：

- 普通用户推荐 `*-setup.exe`（NSIS）。
- 企业部署或 MSI 场景使用 `*.msi`。

NSIS 支持简体中文和英文，并跟随 Windows 显示语言。发布包暂未配置 Windows Authenticode 签名；若 SmartScreen 显示提示，请确认安装包来自本仓库 Releases 页面。

## 当前限制

- 当前仅发布 Windows x64 安装包。
- HTTP MCP 使用明文传输，只能用于可信局域网或 VPN。
- 不支持 SSH Agent、Pageant、硬件安全密钥或 SSH 证书认证。
- 本地文件夹暂不支持递归拖放上传。
- Trae、Trae CN 和 Cursor 的 User Rules 需要手工粘贴。

## 本地开发

环境要求：Windows、Node.js 20+、Rust stable 和 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm ci
npm run tauri dev
```

```bash
npm run verify:all
cargo audit --file src-tauri/Cargo.lock
```

## 社区鸣谢

感谢 [LINUX DO 社区](https://linux.do/) 对开源交流与项目成长的支持。

## 许可证

FsTTY 使用 [MIT License](LICENSE) 开源。
