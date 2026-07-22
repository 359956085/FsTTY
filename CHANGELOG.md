# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

<!-- release-notes:zh-CN:start -->
### 简体中文

- 优化应用内“立即更新”按钮，使主要操作状态更清晰。
- 更新说明改由 CHANGELOG.md 生成，并按当前界面语言显示。
- NSIS 安装包新增简体中文，并根据 Windows 显示语言自动选择中英文。
- 修复认证阶段连接中断被误报为密码错误的问题，并对瞬时中断自动重试一次。
- 升级到 xterm.js 6，支持 tmux 通过 OSC 52 写入 Windows 剪贴板，并增加可关闭的安全设置。
- 修复 tmux 鼠标复制使用默认 OSC 52 目标时未写入 Windows 剪贴板的问题。
- 修复 WebView2 下搜狗输入法按 Shift 切换英文时最终文字未进入终端的问题。
<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Improved the in-app “Update now” button so the primary action is clearer.
- Release notes are now generated from CHANGELOG.md and shown in the current interface language.
- Added Simplified Chinese to the NSIS installer with automatic language selection based on Windows.
- Fixed authentication connection interruptions being reported as invalid passwords, with one automatic retry for transient interruptions.
- Upgraded to xterm.js 6 with tmux OSC 52 clipboard support and an option to disable remote clipboard writes.
- Fixed tmux mouse selections using the default OSC 52 target not reaching the Windows clipboard.
- Fixed Sogou IME text not reaching the terminal after switching to English with Shift under WebView2.
<!-- release-notes:en-US:end -->
