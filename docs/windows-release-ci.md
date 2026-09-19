# Windows 发布与缓存

工作流分为无签名验证和正式发布两种模式。两种模式都执行版本、类型、Lint、前端测试、Rust 格式、Clippy、Rust 测试、依赖审计及完整 Windows 构建；任何检查或构建失败都会令整次运行失败，正式发布不会继续。

## 发布及验证运行

- 推送与仓库版本一致的 `vX.Y.Z` 标签触发 Tauri 更新签名和正式发布。同一标签的运行串行排队，不自动取消正在进行的发布。
- 从默认分支手动运行且保持 `publish=false` 时进入无签名验证模式，不读取 Tauri 更新私钥。它上传名称带 `UNSIGNED` 的安装包、双语警告和验证清单，保留十四天，不创建更新签名、`latest.json`、GitHub Release 或 CNB Release。
- 手动设置 `publish=true` 时必须从与仓库版本一致的标签运行，并进入与标签推送相同的更新签名发布模式。无签名验证从标签或非默认分支启动时会在准备阶段失败。
- 对同一标签手动运行一次 `cold-cache=true`，再运行一次 `cold-cache=false`。后者需等待该提交在 main 的预热任务成功。对比 Actions 总耗时、缓存命中、恢复体积及步骤摘要；冷缓存模式只查缓存信息，不恢复或保存 Rust 缓存。
- 正式发布前创建草稿，上传安装包、签名和 `latest.json`，检查数量、大小、SHA-256 及标签提交，再转为正式发布。

正式发布的 Tauri 更新签名使用 `TAURI_SIGNING_PUBLIC_KEY` 仓库 Variable，以及 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets。项目不使用 Windows Authenticode 证书，Broker、桌面程序和安装包的 Windows 签名状态均应为 `NotSigned`；正式发布不读取 PFX 或时间戳配置。

无签名验证直接使用仓库配置中的更新公钥；若同时配置 `TAURI_SIGNING_PUBLIC_KEY`，它仍必须与仓库一致。正式发布要求该 Variable 存在并在 Broker 和桌面编译前核对。`CNB_TOKEN` 只传给同步步骤，main 预热和无签名验证不读取任何发布 Secret。正式发布缺少更新私钥、更新签名或清单时会在上传前失败。

## 缓存与编译

质量检查与发布验证共享 `verify` 缓存；main 预热与标签构建共享 `release` 缓存。仅 main 保存，标签只恢复；未命中仍可冷构建。缓存键包含平台、Rust 工具链、Cargo 依赖、编译环境及用途代次。

Broker 使用独立目录和 `crt-static`；桌面使用独立正式编译目录。安装器仍读取 `src-tauri/target/broker-package/fstty-broker.exe`。调整硬编码编译参数时须同步升级共享缓存代次，避免复用旧参数缓存。

main 上的前端、Rust、依赖、资源、脚本和工作流变更触发预热，纯文档变更跳过。预热复用完整验证产生的前端产物，只进行 Broker 和桌面正式编译，不打包、不签名、不发布。

发布前端仅构建一次。CI 临时配置关闭 Tauri 前置构建及自动生成更新签名，也不配置 Windows `signCommand`。Broker、桌面程序和 NSIS 安装包构建完成后会逐一校验产品版本及 `NotSigned` 状态。正式发布随后使用 Tauri 私钥签署最终安装包字节，并生成 `.sig` 与 `latest.json`。

无签名验证使用同一套优化编译和 NSIS 打包路径，但跳过 Tauri 更新签名。验证目录仅允许 `*-UNSIGNED.exe`、`VALIDATION-ONLY.txt` 和 `validation-context.json`，因此不能被正式发布脚本接受。普通本地构建和 `npm run verify:all` 保持原行为；临时配置与产物均在已忽略目录内。

Tauri 更新签名用于让已安装的 FsTTY 校验更新包未被替换，并不会让 Windows 显示受信任发布者。由于项目不使用 Authenticode，Windows 或 SmartScreen 显示“未知发布者”属于预期行为。

## 失败恢复

- GitHub 附件上传或校验失败：草稿保留，在 Actions 选择 **Re-run failed jobs**，复用该次运行已经构建的 Artifact。
- CNB 同步失败：同样只重跑失败任务。GitHub 已正式发布且附件完全一致时，跳过附件修改，再用本地产物同步 CNB，不下载 GitHub 附件或重新编译。
- 不要用 **Re-run all jobs** 代替恢复：重新打包、签名及生成时间可能改变文件，正式 Release 不允许覆盖不同附件。
- 标签移动、未知附件、Windows PE 意外带有 Authenticode、更新签名缺失、清单哈希错误或更新元数据不匹配均直接失败，不能通过恢复绕过。

步骤摘要记录前端、Broker、桌面、NSIS、更新签名、缓存恢复、产物体积和 GitHub 上传耗时。Artifact 上传与缓存传输的耗时及体积同时保留在 Actions 原生日志中。实际提速以同一提交的冷、热 CI 运行测量为准。

## 本次本地验证

2026-09-19 在 Windows 完成 `npm run verify:all`：82 个前端与脚本测试文件共 577 项测试通过，应用 Rust 测试 334 项通过、2 项按环境要求忽略，Broker 单元测试 35 项、SSH 边界测试 5 项及网络测试 10 项全部通过，格式、Clippy 和生产前端构建同时通过。

| 阶段 | 本地耗时 |
| --- | ---: |
| Broker 无签名优化编译 | 42.2 秒 |
| 桌面无签名优化编译 | 152.9 秒 |
| NSIS 无签名打包 | 12.4 秒 |

本地 `collect-validation` 确认 Broker、桌面程序和安装包的 `ProductVersion` 均为 `1.6.2`，签名状态均为 `NotSigned`。最终验证安装包大小为 12,486,461 字节，SHA-256 为 `31aaa523f48c39a7dea1d2e2d3645169a5322fdbaf9b79f673f4a6401d94263e`；目录不含 `.sig` 或 `latest.json`。本次只执行编译与产物隔离校验，未安装、上传或发布。这里使用本地已有依赖，不能作为 GitHub CI 冷、热缓存提速结果；远端 Artifact 仍需在改动进入 main 后手动运行 `publish=false` 验证。
