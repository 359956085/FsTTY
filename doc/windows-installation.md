# Windows 自选目录与覆盖升级

桌面目录可选，默认 `Program Files\FsTTY`。凭据服务、原生管理工具和卸载入口固定在这个受保护目录。新安装记录位于其 `installation\active.json`，普通用户只能读取。

独立服务构建时静态链接 C 运行库，可在未安装 Visual C++ 运行库的系统上启动。发布前同时检查桌面和服务的 DLL 依赖；安装工具无法启动时，安装器显示退出码并返回失败，不显示空白错误框。

安装器首先使用受保护安装记录；首次升级则读取机器级和原调用用户的 NSIS 安装登记。多个候选要求选择，静默安装遇到多个候选直接返回失败；便携版可手动选择原目录。更换目录只切换有效安装，旧目录保留，不自动递归清理。安装包只替换 `fstty.exe`，不删除同目录其他文件。

安装器在 UAC 前保留普通调用进程；另一管理员批准后仍读取原用户登记，桌面以原用户令牌启动。直接从已经提权的控制台启动且缺少原调用进程时拒绝安装，应改从普通桌面启动。

程序替换由受保护暂存目录中的 Rust 安装工具完成。目录逐层相对已验证句柄打开，并持有不可删除句柄；末级目录使用自动清理的不可删除哨兵保持非空，防止验证后改成重解析点。拒绝已有重解析点和硬链接，写入新文件后原子替换目录项，避免修改竞争过程中创建的硬链接所指向的原文件。读取产品版本信息不会执行旧程序。旧桌面结束后才替换文件；取消关闭或文件占用都会停止操作。非空目录限制见[微软重解析点文档](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/fsctl-set-reparse-point)。

桌面、服务、卸载程序、安装登记和密文数据库有恢复记录。安装失败恢复原组合；中断留下的事务在下一次安装时先恢复。回滚失败保留材料并报错。在线更新继续校验发布签名，目标目录只能来自当前有效安装记录。普通卸载保留用户配置、原始私钥和 ProgramData 中的受保护凭据。

新版首次运行修复匹配旧目录的快捷方式、自启和 stdio 配置；保留自启关闭状态、命令参数、其他服务器配置及提示词。MCP 使用稳定启动器和更新后的独立运行副本。旧副本不能通过新版本的哈希检查时提示重启 Agent。无法识别的自定义命令保留并提示重新一键配置；设置中的“安装与启动入口”可查看失败项和重试。

## 本地开发与 RustRover 调试

Windows 的 Debug 和 Release 桌面构建均使用 GUI 子系统，启动时不额外创建终端窗口。RustRover 的运行输出仍在 IDE 中查看，应用日志可在设置中打开日志目录；MCP stdio 继续使用客户端传入的标准输入和输出管道。

Windows 桌面启动时读取有效安装记录，核对当前程序的路径和版本，Debug 构建同样执行此检查。已有安装记录时，从 RustRover、`cargo run` 或 `npm run tauri dev` 启动 `target/debug/fstty.exe` 会显示“这份 FsTTY 已不是当前安装”，并给出应启动的安装路径。这是应用的启动校验，不是 RustRover 的编译错误；管理员权限也不能使路径匹配。当前没有与现有安装隔离的开发启动模式。

在项目根目录构建本地 Debug 验证安装包：

```powershell
npm ci
npm run tauri -- build --debug --bundles nsis --config src-tauri/windows/validation.conf.json
```

已有匹配的 `node_modules` 时无需重复 `npm ci`。Windows 配置的 `beforeBuildCommand` 自动构建前端和静态链接运行库的凭据服务；无需单独手工复制程序。安装包位于 `src-tauri/target/debug/bundle/nsis/`。从普通权限桌面双击安装包，由安装器请求 UAC，完成后启动它登记的安装目录中的 `fstty.exe`。直接打开构建目录里的程序仍会触发路径校验。验证包不含正式在线更新签名，不能用于发布。

构建前关闭开发版的报错对话框或停止 RustRover 中的运行进程。对话框未关闭时，`target/debug/fstty.exe` 仍被进程占用，Cargo 可能显示 `failed to remove file` 和“拒绝访问”。

安装包会更新当前有效桌面、凭据服务和安装登记；若需保留日常使用的安装，请在 Windows Sandbox 或可还原的虚拟机中安装验证包。

在安装了对应 Debug 验证包的机器上调试时，打开同一份源码并在 RustRover 中附加 `src-tauri/Cargo.toml`，保留本次构建生成的 `src-tauri/target/debug/fstty.pdb`。启动已安装的桌面后，使用 **Run → Attach to Process**（`Ctrl+Alt+F5`），选择对应的 `fstty.exe` 进程；检查其路径与安装记录一致。程序和调试符号必须来自同一次构建。需要检查启动阶段时，可使用 **Run → Attach to an Unstarted Process**，指定已安装程序的完整路径后再启动它。菜单及调试器支持见 [RustRover 附加调试文档](https://www.jetbrains.com/help/rust/attach-to-process.html)。在 Sandbox 或虚拟机中测试时，调试器也需运行在对应测试环境中。

自动回归使用 `npm run verify:all`，不需要启动桌面或替换已安装的服务。仅检查前端布局时运行 `npm run dev`，在浏览器访问 `http://127.0.0.1:1430/`；浏览器没有 Tauri 后端，SSH 连接和配置保存不能通过这种方式验证。

## 隔离环境验收

以下涉及安装、关闭进程及卸载的步骤只能在可还原的 Windows 虚拟机中执行。先拍摄虚拟机检查点；使用生成的测试凭据，禁止导入真实秘密。脚本仅检查状态，不替用户点击 UAC 或安装确认。

1. 新装到含中文和空格的目录，运行下方 `AssertInstalled`；验证普通用户不能改写服务及安装记录。
2. 从已登记的旧 NSIS 版和未登记便携目录分别原地覆盖；放置额外测试文件，确认保留。多候选不得默认覆盖任何一个。
3. 换到第二个目录并检查新路径；旧目录额外文件和旧程序保留，机器卸载登记只有一个。测试快捷方式、自启开／关、stdio 自定义参数和 HTTP Token 均保持预期。
4. 使用另一管理员批准安装，核对启动后的桌面属于原用户；分别登录另一个用户检查入口修复。取消 UAC 和旧进程关闭确认时保持旧安装。
5. 用虚拟机检查点模拟服务安装失败、磁盘写入失败及安装中断；重新运行包后核对桌面、服务、登记和数据恢复一致。签名在线升级还需使用匹配发布测试密钥的两个递增版本。
6. 尝试硬链接、目录联接、父目录替换及伪造产品文件；应拒绝替换且不改变目录外文件。
7. 卸载当前安装，执行 `AssertUninstalled`；旧目录、额外文件、用户配置及受保护数据必须保留。

```powershell
powershell -NoProfile -File scripts/test-windows-installation.ps1 -Mode AssertInstalled -ExpectedDesktopDirectory 'D:\测试 Apps\FsTTY'
powershell -NoProfile -File scripts/test-windows-installation.ps1 -Mode AssertUninstalled -ExpectedDesktopDirectory 'D:\测试 Apps\FsTTY'
```

本地自动验证使用 `npm run verify:all`，安装包使用 `npm run tauri -- build --debug --bundles nsis --config src-tauri/windows/validation.conf.json`。验证包没有正式在线更新签名，不用于发布。构建成功和文件锁单元测试不能代替上述隔离环境验收。

2026-09-15 隔离验收：Windows Sandbox 中已通过完整 NSIS 包覆盖用户级旧目录、无旧登记时安装到默认目录、中文及空格目录迁移、多个候选时拒绝静默覆盖、机器快捷方式、强制中断后的事务恢复和核心卸载。普通测试用户无法读取凭据数据库或服务内存，也无法改写服务程序、有效安装记录或服务配置。测试数据库未导入真实凭据，卸载保留数据库、旧目录及额外文件。

2026-09-16 补充验收：原生安装向导、自选中文目录、原用户普通权限启动、取消卸载和完整卸载均通过。实测用户快捷方式、自启及 stdio 路径修复，并保留参数、HTTP 配置和全局提示词；已关闭的自启没有被重新开启。第二个普通账号首次启动仅修复自己的入口，未改动原用户配置。新版从非有效目录启动时，明确提示当前安装位置。

本次自动验证通过前端 417 项、Rust 337 项，另有 2 项原有忽略测试。双账号测试位于同一沙盒桌面会话；实际 UAC 交互、快速用户切换或跨远程桌面会话、带发布签名的在线升级与更多失败回滚场景仍需验收。当前工作环境的正式安装没有被替换。

## 依赖审计

2026-09-15：将 `rustls` 更新至 `0.23.45`，修复 RUSTSEC-2026-0285；`chacha20`、`wnaf` 分别更新至 `0.10.2`、`0.14.1`，移除撤回版本。`cargo audit --file src-tauri/Cargo.lock` 返回成功，未新增豁免。Tauri 间接依赖的维护状态和 glib 提示继续显示，未隐藏或改成忽略。
