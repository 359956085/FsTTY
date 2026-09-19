# Windows 独立 SSH 凭据服务

此功能位于开发分支，尚未作为新版本发布。Windows 桌面支持自选目录，`fstty-broker.exe` 与卸载工具固定安装到 `Program Files\FsTTY`，服务名为 `FsTTYBroker`，账号为 `NT SERVICE\FsTTYBroker`。其他平台继续使用进程内 SSH 与系统凭据库。目录识别和旧版覆盖见[安装说明](windows-installation.md)。

## 保护范围

防止同账号未提权程序直接读取已托管的密码、私钥及口令。管理员、导入前的原件、剪贴板、未清理旧副本以及已经允许的服务器操作不在此保护范围内。MCP Token 和分组权限不迁移；已获命令权限的 Agent 仍能执行远程命令。

数据在 `ProgramData\FsTTYBroker`，仅允许 SYSTEM、管理员和服务 SID 访问。数据库记录先经过机器范围 DPAPI 加密，再写入 SQLite；事务日志与回滚副本同样仅含密文。目录所有者、重解析点、硬链接和访问控制均在安装及启动时检查。机器范围 DPAPI 不区分同机用户，隔离依赖独立服务身份与 ACL。[DPAPI 文档](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

服务配置不允许普通用户修改，进程权限不允许普通用户读取内存。虚拟服务账号不属于 LocalSystem。[服务访问权限](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)

## 连接与审批

- 客户端只提交会话 UUID；地址、端口、用户名、凭据和可信主机密钥由服务保存。修改用户目录中的会话文件不能改变实际认证目标。
- 管道为本地 `FsTTYBroker-v1`，拒绝远程客户端。客户端提交秘密前将管道服务进程 PID 与 SCM 比对；服务从模拟令牌读取 SID 和提权状态，不接受客户端自报身份。
- 请求本地凭据服务始终通过本机命名管道直连，不使用应用代理、系统代理或 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 等环境代理。状态、管理、迁移、更新及 SSH 数据管道均使用此入口。控制消息中的代理快照用于服务连接远程 SSH 目标。
- 客户端访问掩码明确排除 `FILE_CREATE_PIPE_INSTANCE`；普通用户不能创建同名服务实例。管道使用中完整性标签以允许普通桌面连接。[命名管道安全说明](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- 控制消息最多 2 MiB，私钥最多 1 MiB；最多 64 个客户端，每条 SSH 连接最多 32 个会话通道。通道队列有界，双向流独立等待窗口。
- 服务完成远端主机校验及认证，再通过本地 SSH 通道代理承载现有终端、SFTP 和命令接口。只允许会话通道；不开放 TCP 转发、本机 Shell、凭据读取、任意签名或本地路径接口。
- 修改凭据、认证目标、信任指纹或删除记录需 UAC。原生窗口显示调用用户、会话、配置版本、目标和指纹；请求一次有效、五分钟过期。变更提交后旧连接关闭。
- 秘密不经过 WebView。私钥从原件迁移，或由安全窗口读取剪贴板，内容不显示；密码控件拒绝外部消息和辅助功能读取。原件和剪贴板仍由用户自行清理。

名称、标签和分组等非认证元数据留在用户配置中，不触发 UAC。服务启动有短暂等待；失败显示修复入口，通过 UAC 后的原生窗口确认重新注册及启动服务，不回退旧凭据模式。程序缺失时需重新运行安装包。

## 迁移与恢复

1. 使用原登录用户的普通桌面进程读取旧密码、清单和私钥分块；文件私钥读取后不再用于后续连接，原文件保留。
2. 可一次审批最多 32 个迁移会话。管理窗口先探测主机密钥而不发送密码，再显示完整列表；批量保存使用一个事务。
3. 服务提交并验证后，原用户进程清理密码、私钥清单及所有分块，再更新清理状态。失败显示“仍有旧副本”，可重试清理。
4. 已有服务记录时不再读取旧秘密。删除记录保留版本墓碑，禁止重新导入旧副本。数据库损坏或初始化后缺失时拒绝启动，不创建替代空库。

管理窗口可使用另一管理员账号批准，记录仍绑定最初请求进程的 SID。轻量模式销毁普通窗口不会关闭连接；客户端进程退出或服务重启则中断连接，不重放命令和传输。普通卸载保留受保护数据；换机或重装系统需重新导入自有原件。

## 安装与更新

Windows 使用机器范围 NSIS，桌面目录与固定服务目录分离。安装引导程序从 Program Files 的独立临时目录执行，在锁定并检查目标路径后停止服务、备份密文数据库和程序。服务启动失败会尝试恢复旧程序、安装登记及数据库；无法自动恢复时明确报错并保留数据。

在线更新先在普通客户端下载，再将最多 256 MiB 的安装包通过管道传到服务受保护暂存区。服务与提权端分别用构建时固定的发布公钥验签，并检查签名覆盖的 PE 版本高于当前版本。提权端持有禁止写入和删除的文件句柄后启动安装包；请求有期限且不能重复使用。未配置公钥的开发构建拒绝在线安装。

发布流程继续从 Actions Variable 注入公钥；私钥只用于发布签名。`windows/validation.conf.json` 仅用于生成不带更新签名的本地验证安装包，不能用于正式发布。

## 验证

普通用户可运行只读代理绕过检查。它使用现有服务的状态接口，为测试子进程设置本机代理陷阱并移除环境代理例外；检查服务响应成功且代理没有收到连接。测试不修改应用或系统的代理设置。

```powershell
cargo build --manifest-path src-tauri/Cargo.toml -p fstty-broker --example windows_acceptance --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-local-credential-service.ps1
```

```powershell
npm run verify:all
npm run tauri -- build --debug --bundles nsis --config src-tauri/windows/validation.conf.json
cargo build --manifest-path src-tauri/Cargo.toml -p fstty-broker --bins --examples --locked
```

在管理员 PowerShell 中运行以下测试，只使用程序生成的测试会话、本机 SSH 和测试密码。已有正式 Program Files 安装时，脚本拒绝覆盖。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-broker.ps1 -Mode Install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-broker.ps1 -Mode Verify
```

报告位于 `src-tauri/target/broker-acceptance.json`。控制端提权，攻击子进程复用交互桌面的普通权限令牌，并独立核对 SID 相同、未提权。检查数据库读取、程序替换、服务内存、服务配置、管道伪造、未批准请求及正常 SSH 操作；检查数据库没有测试明文，并在结束时删除测试凭据。

跨账号验收使用 `-Mode CrossAccount`，另存 `broker-cross-account.json`。控制端生成对应的 `.ready.json` 后，在另一普通账号下运行验收程序的 `--foreign <id> <报告路径>.foreign.json`，须在 50 秒内完成。应使用可正常访问本地服务的独立 Windows 测试账号；沙箱令牌拒绝管道连接不能替代服务端 SID 隔离验收。

自动回归另覆盖协议版本、超长帧、跨 SID 存储、审批过期和重放、批量回滚、清理状态、密文损坏、主机指纹不匹配、带口令私钥认证、错误口令、终端、命令、3 MiB SFTP 往返、取消及签名篡改。发布前仍需在隔离虚拟机中执行断电恢复、跨管理员迁移、完整签名升级回滚，以及真实 GUI/MCP/开机自启/轻量模式的组合验收；普通单元测试不能替代这些环境测试。

### 本机验收记录（2026-09-14）

- `npm run verify:all` 通过；后续 Rust 修改另运行 `npm run verify:rust` 通过。
- 专用验收脚本完成真实服务安装及同账号普通权限攻击测试，报告 `passed: true`，数据库未发现测试明文，测试凭据已删除。
- 当前安装的是测试服务，未替换正在运行的旧版桌面，也未迁移用户真实凭据。
- 跨账号验收因另一账号未能建立正常管道连接而超时，不能判定通过；保留独立失败报告。
- 尚未完成完整安装包的安装、卸载、签名升级和回滚验收；原用户旧凭据枚举及迁移清理、跨管理员审批、原生安全窗口输入隔离、断电恢复和 GUI/MCP/自启/轻量模式组合仍需隔离 Windows 环境验证。

### SSH 原生确认窗口（2026-09-15）

单项与批量审批使用原生卡片布局，完整显示目标和主机指纹，变化指纹及删除操作突出警示。Windows 账号在摘要中显示，SID、会话 ID 和配置版本可展开。内容超出工作区时滚动，取消和操作按钮固定在底部；支持 Tab、Enter、Escape 及就地必填提示。

普通客户端在提权前解析应用主题，只传递 `--theme light` 或 `--theme dark`；旧调用使用系统主题。外观参数不进入审批协议。秘密仍由独立提权窗口接收，生产窗口强制启用捕获保护；服务修复和更新窗口保持原状。

预览程序仅使用生成的测试数据，不连接服务、不读取真实凭据。显式启用 `approval-preview` 才能构建，默认服务和安装包不包含此功能。预览在指定 DPI 下创建真实原生窗口，自动检查布局、详情展开、滚动、必填提示、键盘确认与取消，以及填入测试密码后拒绝外部线程读取。截图仅来自这个无服务预览窗口。

```powershell
cargo build --manifest-path src-tauri/Cargo.toml -p fstty-broker --example approval_preview --features approval-preview --locked
New-Item -ItemType Directory -Force src-tauri/target/approval-preview | Out-Null
foreach ($scene in @('password', 'key', 'migrate', 'delete', 'trust', 'long', 'batch', 'batch-delete')) {
    foreach ($theme in @('light', 'dark')) {
        foreach ($dpi in @(96, 144, 192)) {
            & ./src-tauri/target/debug/examples/approval_preview.exe $scene $theme $dpi "src-tauri/target/approval-preview/$scene-$theme-$dpi.bmp"
            if ($LASTEXITCODE -ne 0) { throw "预览检查失败：$scene / $theme / $dpi" }
        }
    }
}
```

本次 48 组预览检查全部通过，覆盖 100%／150%／200% 布局、长地址、完整指纹、32 项迁移与 500 项删除列表。已人工检查深浅主题截图。`npm run verify:all` 通过；后续窗口细节修改另通过 broker 单元及 SSH 集成测试、格式检查和包含预览的 Clippy。已构建 Windows NSIS 验证包。

现有测试服务的同账号普通权限攻击与审批验收再次通过，测试凭据已清理，未替换或重启服务。该复测使用已有服务；预览输入消息测试不能替代跨进程 UI 自动化攻击与真实 UAC 窗口验收，跨显示器实时 DPI 切换也仍需人工检查。前述安装、升级和隔离环境验收待办继续保留。
