# 本地终端历史：实现与验证

更新后的 CMD、PowerShell 和 Git Bash 在停止、退出、关闭标签及重启应用后保留各 Shell 原生历史。只对新启动的进程生效；轻量恢复接回原进程，不重新加载历史组件，不重复请求 UAC。原生历史独立于“本地终端高亮”。2.0.1-beta.1 起，新提交的单行命令也接入 FsTTY 全局命令库；两套历史分别保存。

## 查询方式

| Shell | 恢复后的查询入口 | 保存时机 |
| --- | --- | --- |
| CMD | Clink `history`、↑／↓、F7 | Clink `history.save`、`history.shared`，接受命令后追加并在提示符阶段共享 |
| PowerShell 7／5.1 | PSReadLine ↑／↓及历史搜索 | `HistorySavePath` 指向专用文件，`SaveIncrementally`；保留已有按键与历史过滤 |
| Git Bash | Bash `history`、↑／↓及搜索 | 提示符阶段 `history -a` 追加本标签命令，随后 `history -c`／`history -r` 同步原生文件 |

PowerShell `history`／`Get-History` 属于 PowerShell 引擎的本次会话历史，不会导入上次进程的记录。恢复的命令仅用于查询或手动复用，不自动执行。Bash 正在执行时被强制停止的最后一条命令不保证保存，已经返回提示符的命令会先追加保存。

Bash 的 `history -n` 会因多标签追加导致其文件行游标跳过记录，因此在保留原生容量控制的前提下，每次提示符重载专用文件。`HISTCONTROL`、`HISTIGNORE`、`HISTSIZE`、`HISTFILESIZE` 保留用户配置；未配置容量时分别使用 10000／20000。保留字符串／数组形式的 `PROMPT_COMMAND`，只追加历史同步函数；不可修改的提示符配置明确降级。受控 rc 文件先按登录 Shell 顺序加载 `/etc/profile` 及首个可读的 `~/.bash_profile`、`~/.bash_login`、`~/.profile`，不写入这些文件。如果受控 rc 文件本身无法创建，使用无 profile 的交互 Shell 和内存历史，避免访问外部历史。用户 profile 将外部 HISTFILE 设为只读、无法重定向时，同样明确提示并进入干净的内存历史 Shell，不修改外部文件或用户退出钩子。

## 身份、存储与安全

分区路径为 `FsTTYLocalHistory/<SHA-256(SID)>/<终端配置 UUID>/<Shell>/<standard|administrator>/`。普通令牌使用 Windows LocalAppData，已校验的管理员令牌使用 ProgramData。不同 Windows 用户、配置、Shell 及实际权限隔离；同配置同权限的标签共享。配置改名或起始目录变更不改变 UUID，已有标签使用其固定的启动权限。删除配置不会删除历史，新配置生成新 UUID。

每级专用目录验证所有者和 DACL，禁止重解析点，保留不可删除的目录句柄；历史文件拒绝额外硬链接。管理员目录只允许 Administrators／SYSTEM 写入，普通用户目录只允许该用户／SYSTEM 写入。静态 Clink 设置和 inputrc 校验内容并锁定只读，允许多标签并发读取；Clink 活跃历史文件允许独占写入。配置目录仅存放原生数据与静态设置，Lua／rc 脚本、启动令牌及高亮开关使用每个 host 的临时资源，不写入共享配置。

停止时只删除临时组件和脚本，保留历史。CMD 关闭高亮仍加载受控 Clink，不读取用户 Clink 扩展、默认历史或外部标签。PowerShell 使用已有 PSReadLine，不安装模块、不改变 profile、执行策略或已有按键；保留过滤函数的结果和调用次数；不兼容的自定义编辑器不替换。模块／目录／初始化失败时提示一次“本地终端历史无法保存或恢复，当前终端仍可使用。”，可用时回退内存历史。已有文件不清空、不覆盖修复，不自动导入旧文件。

内部 host 启动协议增加可选配置 ID、历史通知令牌；连接元信息增加可选 `history` 状态，旧启动及恢复记录继续可读。历史失败通知按启动 nonce 校验并去重，日志只记录阶段和系统错误，不记录命令。轻量接回沿用原有命令通知通道。公共启动 IPC 请求、SSH／MCP、会话配置与数据库不变。

## 全局命令库（2.0.1-beta.1）

仅记录更新后新启动进程中由 Shell 接受的单行命令，普通／管理员与 SSH 共用现有 CommandHistoryService 和数据库。原生历史文件、方向键召回及全局库分别保存；不会导入历史文件、从按键或回显猜测命令，也不采集交互程序的输入。空白、取消、控制字符、多行及原生过滤排除项不采集。重新执行同一命令是新提交，是否合并由全局去重设置决定。

- CMD 订阅受控 Clink 的 `onhistory`，返回 nil，不修改原始历史或执行文本。另行排除未完成的 CMD 物理行（行尾续行符或未闭合括号）；CMD 的 More? 读取不进入采集。较复杂的物理行可保守排除，不把续行拆成命令。
- PowerShell 代理原 AddToHistoryHandler，每次只调用一次并原样返回；没有自定义过滤器时使用模块公开的默认过滤接口。只允许 MemoryAndFile／旧版 true，拒绝 MemoryOnly、SkipAdding 和 false。只有原 PSConsoleHostReadLine 返回的本次接受行才会通知，文件重载不会通知。原生重复项跳过过滤器时仅复用同一命令的上次决定。不能保留默认敏感过滤或自定义编辑器时禁用本进程采集并提示，不替换编辑器。
- Git Bash 在 PS0 阶段、执行用户命令之前观察本次新增的原生记录；在用户 PROMPT_COMMAND 和历史重载前发送，最终提示符钩子刷新基线。PS2 标记整个续行，多行即使被 cmdhist 折叠也排除。保留用户 PS0／PS2 后缀及提示符钩子。整个引导作为一个复合块解析，防止开启 history 后将引导代码本身加入原生历史。

通知携带进程随机 UUID、单调序号及有界 Base64 UTF-8；host 增量解析，验证 nonce、长度、序号和完整单行，原始 PTY 字节原样转发。主进程使用应用共享的 128 条异步写入队列，SQLite 等待不占用终端转发任务。满队列或写入失败只提示一次，不阻断输入，不在日志写命令内容。正常应用退出最多等待队列 2 秒；超时仅记录阶段，强制杀进程或持久存储长时间阻塞不保证待写队列落盘。轻量模式继续由后端采集，恢复不重新注入；完整重启不回放通知或导入旧记录。

本地标签复用历史入口、列表和搜索快捷键，未运行时禁用。选择只填入，不附加回车：受支持编辑器在本进程尚未占用的 Ctrl+Alt+F12 序列上绑定原生整行删除，随后填入命令，光标处于中间也会清除整个草稿。不会替换用户已有按键，不写 profile；Clink 用 rl_buffer，PSReadLine 用 GetBufferState/Delete，Bash Emacs 用 kill-whole-line。Vi 模式、冲突按键、旧进程或无法验证能力时只复制并提示手动粘贴。查询和复用不依赖采集成功。

内部 host 协议及连接元信息增加可选 command token，旧记录缺失时继续可读。公共 IPC 请求、全局历史数据库、SSH／MCP 及终端配置结构不变。无额外采集开关，已运行进程需重新启动才启用。

## 开发验证

```powershell
npx vitest run scripts/local-history-bootstrap.test.mjs scripts/local-global-history.test.mjs scripts/local-highlight-bootstrap.test.mjs src/features/sessions/TerminalPane.test.tsx src/features/sessions/localCommandHistory.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib services::local_terminal_service:: --locked
npm run verify:all
npm run check:release
```

PowerShell 引导测试用模拟模块覆盖现代／旧版参数、高亮关闭、缺模块、不可写路径及自定义编辑器，分别由现有 PowerShell 5.1／7 执行，不访问个人历史。Git Bash 测试使用临时 HOME 与配置，验证真实交互进程的追加、重开、强制停止、中文、过滤与双标签同步。Rust 测试覆盖稳定分区、并发文件锁、内容保护、ACL／硬链接拒绝、旧协议与失败通知。前端回归覆盖三类 Shell 的降级、重试、nonce 隔离以及原有轻量恢复、输入及高亮行为。

原生 ConPTY 夹具仅在隔离 Windows 中执行，使用专门目录，不调用 UAC：

```powershell
$env:FSTTY_HISTORY_FIXTURE_ROOT = 'C:\FsTTY-history-fixture'
New-Item -ItemType Directory -Force $env:FSTTY_HISTORY_FIXTURE_ROOT
cargo test --manifest-path src-tauri/Cargo.toml --lib conpty_history_stop_restart_and_natural_exit -- --ignored --test-threads=1 --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib conpty_global_history_and_safe_insertion -- --ignored --test-threads=1 --nocapture
```

两个夹具要求三类 Shell 可用，缺失即失败；全局夹具检查不回放旧历史、重复提交序号、行中光标清行填入及退出通知（CMD 沿用原生 exit 排除），高亮开关各运行一次。每类执行停止后重开、自然退出后重开，并切换高亮快照。分别在普通／管理员环境和 PowerShell 7／5.1 安装环境重复执行。完整 GUI 关闭与重启、实际 UAC 取消重试、IME、多行粘贴、补全、Ctrl+C、容量／损坏文件、自定义 profile 和真实轻量恢复需隔离环境人工验收，自动测试不能替代。

实现接口参考：[Clink 原生历史](https://chrisant996.github.io/clink/clink.html#saved-command-history)、[PSReadLine 历史选项](https://learn.microsoft.com/en-us/powershell/module/psreadline/set-psreadlineoption)、[Bash 历史](https://www.gnu.org/software/bash/manual/html_node/Bash-History-Facilities.html)。
