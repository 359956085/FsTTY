# Windows 发布与缓存

发布依次执行准备、并行验证与构建、发布。验证包含版本、类型、Lint、前端测试、Rust 格式、Clippy、Rust 测试和依赖审计。任何检查或构建失败均不能正式发布。

## 发布及验证运行

- 推送与仓库版本一致的 `vX.Y.Z` 标签触发正式发布。同一标签的运行串行排队，不自动取消正在进行的发布。
- 手动运行必须选择版本标签。默认 `publish=false`，只检查、打包和签名，产物保留十四天，不创建 GitHub Release 或同步 CNB。普通分支运行会在准备阶段失败。
- 对同一标签手动运行一次 `cold-cache=true`，再运行一次 `cold-cache=false`。后者需等待该提交在 main 的预热任务成功。对比 Actions 总耗时、缓存命中、恢复体积及步骤摘要；冷缓存模式只查缓存信息，不恢复或保存 Rust 缓存。
- 正式发布前创建草稿，上传安装包、签名和 `latest.json`，检查数量、大小、SHA-256 及标签提交，再转为正式发布。

Tauri 更新签名沿用 `TAURI_SIGNING_PUBLIC_KEY` 仓库 Variable，以及 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets。Windows 发布还要求 `WINDOWS_TIMESTAMP_URL` 仓库 Variable，以及 `WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD` Secrets；其中 `WINDOWS_CERTIFICATE` 是只含一张带私钥代码签名证书的 PFX 原始字节 Base64，可用 `[Convert]::ToBase64String([IO.File]::ReadAllBytes('certificate.pfx'))` 生成。证书提供商必须给出 RFC 3161 HTTP(S) 时间戳地址。

更新公钥在 Broker 和桌面编译前注入；PFX 只写入临时运行目录，导入当前用户证书库后立即删除文件。`CNB_TOKEN` 只传给同步步骤，main 预热不读取任何发布 Secret。缺少证书、证书不是代码签名用途、PFX 含多个私钥签名证书或时间戳地址无效时，标签构建在上传产物前失败。

## 缓存与编译

质量检查与发布验证共享 `verify` 缓存；main 预热与标签构建共享 `release` 缓存。仅 main 保存，标签只恢复；未命中仍可冷构建。缓存键包含平台、Rust 工具链、Cargo 依赖、编译环境及用途代次。

Broker 使用独立目录和 `crt-static`；桌面使用独立正式编译目录。安装器仍读取 `src-tauri/target/broker-package/fstty-broker.exe`。调整硬编码编译参数时须同步升级共享缓存代次，避免复用旧参数缓存。

main 上的前端、Rust、依赖、资源、脚本和工作流变更触发预热，纯文档变更跳过。预热复用完整验证产生的前端产物，只进行 Broker 和桌面正式编译，不打包、不签名、不发布。

发布前端仅构建一次。CI 临时配置关闭 Tauri 前置构建及自动生成更新签名：Broker 编译后先独立添加 Authenticode 签名；Tauri 在 NSIS 打包阶段通过参数化 `signCommand` 签署补丁后的桌面程序和最终安装包。随后对三份 PE 文件逐一校验签名证书、时间戳和 Windows 信任链，全部通过后才为最终安装包生成 Tauri 更新签名。普通本地构建和 `npm run verify:all` 保持原行为。临时配置与产物均在已忽略目录内。

Authenticode 与 Tauri 更新签名用途不同：前者向 Windows 证明发布者身份并积累下载信誉，后者让已安装的 FsTTY 校验更新包未被替换。签名顺序不能颠倒，因为 Authenticode 会改变安装包字节；更新签名必须覆盖最终已签名的安装包。

## 失败恢复

- GitHub 附件上传或校验失败：草稿保留，在 Actions 选择 **Re-run failed jobs**，复用该次运行已经构建的 Artifact。
- CNB 同步失败：同样只重跑失败任务。GitHub 已正式发布且附件完全一致时，跳过附件修改，再用本地产物同步 CNB，不下载 GitHub 附件或重新编译。
- 不要用 **Re-run all jobs** 代替恢复：重新打包、签名及生成时间可能改变文件，正式 Release 不允许覆盖不同附件。
- 标签移动、未知附件、Authenticode 或时间戳缺失、发布证书不一致、更新签名缺失、清单哈希错误或更新元数据不匹配均直接失败，不能通过恢复绕过。

步骤摘要记录前端、Broker、桌面、NSIS、签名、缓存恢复、产物体积和 GitHub 上传耗时。Artifact 上传与缓存传输的耗时及体积同时保留在 Actions 原生日志中。实际提速以同一提交的冷、热 CI 运行测量为准。

## 本次本地验证

2026-09-18 在 Windows 完成 `npm run verify:all`、27 项发布相关测试、`cargo-audit 0.22.2` 审计及 Actionlint 检查。生成测试密钥后完成正式优化编译、NSIS 打包、独立签名及产物清单校验，未执行安装或发布。

| 阶段 | 本地耗时 |
| --- | ---: |
| Broker 独立目录首次编译 | 64.9 秒 |
| 桌面编译（已有部分依赖） | 182.1 秒 |
| NSIS 打包 | 18.0 秒 |
| Tauri 更新测试签名 | 0.2 秒 |

安装包大小 11.99 MiB；解包后的 Broker、包装目录副本和独立编译产物 SHA-256 完全一致。这里使用本地已有依赖，不能作为 GitHub CI 冷、热缓存提速结果。真实 CI 两次运行的总耗时、缓存命中和恢复体积尚待测量。
