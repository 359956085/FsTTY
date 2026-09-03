# 依赖安全审计基线

复查日期：2026-09-03。

## 当前豁免

- [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)：`rsa 0.10.0-rc.18` 由 `russh 0.62.2` 引入，RustSec 当前未提供修复版本。FsTTY 是 SSH 客户端，不生成服务端 RSA 私钥；使用 RSA 客户端认证仍涉及私钥运算，不将此项视为已消除。保留精确豁免并跟踪上游，不引入未经验证的 Fork。

## 已处理

- `RUSTSEC-2026-0221`：`event-listener` 已从 `5.4.1` 升至 `5.4.2`。
- [RUSTSEC-2026-0194](https://rustsec.org/advisories/RUSTSEC-2026-0194.html)、[RUSTSEC-2026-0195](https://rustsec.org/advisories/RUSTSEC-2026-0195.html)：上游约束已解除。仅协调锁文件中的 `plist 1.10.0`、`wayland-scanner 0.31.11`，两条依赖链统一使用修复版 `quick-xml 0.41.0`；移除两个 XML 漏洞豁免。未使用强制补丁或升级无关依赖。
- 前端生产依赖审计当前无告警。

CI 固定使用 `cargo-audit 0.22.2`。在仓库根目录执行 `cargo audit --file src-tauri/Cargo.lock`，读取根目录 `.cargo/audit.toml`；豁免外任何新漏洞会阻断质量检查。从其他目录执行时需显式传入 `--config`。

审计通过不代表没有风险：仍有 Tauri Linux 依赖的维护状态/健全性提示及上游撤回版本提示，属于当前审计策略允许的警告，不通过扩大漏洞豁免隐藏它们。
