# Windows 发布与缓存

工作流分为无签名验证和发布两种模式。发布模式根据完整版本区分正式版与 beta。两种模式都执行版本、类型、Lint、前端测试、Rust 格式、Clippy、Rust 测试、依赖审计及完整 Windows 构建；任何检查或构建失败都会令整次运行失败，发布不会继续。

## 日常开发检查

项目按单人 Agent 开发组织 CI，不配置 PR 触发、团队审批或多平台矩阵。日常质量工作流只自动响应 main 推送，也支持手动完整运行。仅修改根目录两份 README、CHANGELOG、`doc/`、`docs/` 或 `.rustcodegraph/` 时，推送不触发质量检查；混入其他路径时仍检查，手动运行不受路径过滤影响。

同分支新推送取消旧推送运行。手动运行使用独立运行 ID 分组，不被推送或其他手动运行取消；发布继续排队且禁止中途自动取消。检查和预热任一任务失败仍令日常运行失败，检查失败或取消时不进行预热。

日常 `npm run check:version` 只比较 npm、Tauri、应用/Broker/Network 和锁文件中的项目版本，检查正式/beta 格式并保留更新公钥校验。`npm run check:release` 在此基础上严格核对双语 README 版本徽章，以及对应完整版本的有效日期、唯一版本区块和非空双语说明。发布准备执行后者；日常开发允许发布文档暂未更新。

本地和所有 Windows 检查/构建固定 Rust 1.97.0，包含 rustfmt、Clippy。工具链升级应单独验证后同时修改 `rust-toolchain.toml` 与 Windows 环境 action，避免滚动 stable 引入新的警告。格式、Lint、Clippy 的严格失败规则与依赖审计继续保留。

测试只扫描 `src`、`scripts`，不扫描验收副本、构建材料和缓存。日志弹窗、延迟加载焦点与提取测试使用独立双语夹具，测试语言、渲染、排序、版本边界和关闭行为，不固定当前版本、历史正文或条目数。移除 CSS 字符串、固定颜色/尺寸/间距及专用解析器测试，视觉效果继续记录界面验收；焦点、键盘、缩放、终端实例和调色板映射仍由行为测试覆盖。

工作流回归只固定检查依赖、无签名隔离、并发取消及密钥使用范围，不锁定步骤名称、数量和完整命令列表。文件选择、去重、缓存上限及签名附件集合等具有行为含义的数量断言保留。发布签名、哈希、草稿重跑、已发布附件保护及更新源隔离规则不变。

## 发布及验证运行

- 推送与仓库版本一致的 `vX.Y.Z` 标签触发 Tauri 更新签名和正式发布。同一标签的运行串行排队，不自动取消正在进行的发布。
- Beta 标签使用 `vX.Y.Z-beta.N`，N 为无前导零的正整数，必须与 npm、Tauri、应用/Broker/Network 及锁文件的版本完全一致。双语更新说明使用完整 beta 版本标题；README 的 Shields 版本徽章将后缀中的连字符转义为 `--`，例如 `version-2.1.0--beta.1-2563EB`。
- Beta 与正式版共用标签推送和 `publish=true` 入口、完整检查、构建及 Tauri 更新签名，不增加发布类型开关。Beta 的草稿和最终 Release 均为预发布，`make_latest=false`，上传安装包与 `.sig`，不生成或上传 `latest.json`。产物上下文记录 `channel=beta`；正式版记录 `channel=stable` 并保持三件套。
- Beta 仅在对应 GitHub Release 页面手动下载安装。所有安装版本的自动/手动更新检查均只接受更高的正式版，支持 `2.1.0-beta.1 → 2.1.0`，不提示其他预发布或更低正式版；官方镜像仍只同步正式版，不新增 beta 地址。
- 从默认分支手动运行且保持 `publish=false` 时进入无签名验证模式，不读取 Tauri 更新私钥。它上传名称带 `UNSIGNED` 的安装包、双语警告和验证清单，保留十四天，不创建更新签名、`latest.json` 或 GitHub Release。
- 手动设置 `publish=true` 时必须从与仓库版本一致的标签运行，并进入与标签推送相同的更新签名发布模式。无签名验证从标签或非默认分支启动时会在准备阶段失败。
- 对同一标签手动运行一次 `cold-cache=true`，再运行一次 `cold-cache=false`。后者需等待该提交在 main 的预热任务成功。对比 Actions 总耗时、缓存命中、恢复体积及步骤摘要；冷缓存模式只查缓存信息，不恢复或保存 Rust 缓存。
- 正式发布前创建草稿，上传安装包、签名和 `latest.json`，检查数量、大小、SHA-256 及标签提交，再转为正式发布。
- Beta 同样先上传草稿并核对附件数量、大小、SHA-256、版本类型和标签提交，再转为预发布。已发布的 beta 与正式版附件均禁止替换；重跑只能复用完全相同的产物，类型不一致直接失败。

正式版与 beta 的 Tauri 更新签名使用 `TAURI_SIGNING_PUBLIC_KEY` 仓库 Variable，以及 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets。项目不使用 Windows Authenticode 证书，Broker、桌面程序和安装包的 Windows 签名状态均应为 `NotSigned`；发布不读取 PFX 或时间戳配置。

无签名验证直接使用仓库配置中的更新公钥；若同时配置 `TAURI_SIGNING_PUBLIC_KEY`，它仍必须与仓库一致。正式版与 beta 发布均要求该 Variable 存在并在 Broker 和桌面编译前核对。main 预热和无签名验证不读取任何发布 Secret。发布缺少更新私钥或更新签名时会在上传前失败；正式版还必须有更新清单，beta 必须没有更新清单。

GitHub 的 `prerelease` 和 `make_latest` 行为参照[官方 Release API 文档](https://docs.github.com/en/rest/releases/releases?apiVersion=latest)：预发布不能设为 Latest。本轮本地自动测试与隔离 Windows beta 构建结果见[交互验证记录](../doc/optimization-validation.md#beta-release-与正式版更新隔离2026-10-11)；真实安装升级和远程 Actions 尚待验证。

## 缓存与编译

质量检查与发布验证共享 `verify` 缓存；main 预热与标签构建共享 `release` 缓存。仅 main 保存，标签只恢复；未命中仍可冷构建。缓存键包含平台、Rust 工具链、Cargo 依赖、编译环境及用途代次。

Broker 使用独立目录和 `crt-static`；桌面使用独立正式编译目录。安装器仍读取 `src-tauri/target/broker-package/fstty-broker.exe`。调整硬编码编译参数时须同步升级共享缓存代次，避免复用旧参数缓存。

main 上的前端、Rust、依赖、资源、脚本和工作流变更触发预热，纯文档变更跳过。变更判断并入检查任务，独立的 `scripts/ci-changes.mjs` 仅使用 Node 内置模块，不加载发布或更新日志模块；无法可靠取得差异、旧提交不可达及未知输入均保守预热。移除独立 changes 任务，只在需要预热时上传已验证的前端产物。预热复用该产物，只进行 Broker 和桌面正式编译，不打包、不签名、不发布。

发布前端仅构建一次。CI 临时配置关闭 Tauri 前置构建及自动生成更新签名，也不配置 Windows `signCommand`。Broker、桌面程序和 NSIS 安装包构建完成后会逐一校验完整产品版本、PE 数字版本及 `NotSigned` 状态。随后使用 Tauri 私钥签署最终安装包字节并生成 `.sig`；仅正式版另生成 `latest.json`。

无签名验证使用同一套优化编译和 NSIS 打包路径，但跳过 Tauri 更新签名。验证目录仅允许 `*-UNSIGNED.exe`、`VALIDATION-ONLY.txt` 和 `validation-context.json`，因此不能被正式发布脚本接受。普通本地构建和 `npm run verify:all` 保持原行为；临时配置与产物均在已忽略目录内。

Tauri 更新签名用于让已安装的 FsTTY 校验更新包未被替换，并不会让 Windows 显示受信任发布者。由于项目不使用 Authenticode，Windows 或 SmartScreen 显示“未知发布者”属于预期行为。

## 失败恢复

- GitHub 附件上传或校验失败：草稿保留，在 Actions 选择 **Re-run failed jobs**，复用该次运行已经构建的 Artifact。
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
