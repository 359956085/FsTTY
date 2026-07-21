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
<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Improved the in-app “Update now” button so the primary action is clearer.
- Release notes are now generated from CHANGELOG.md and shown in the current interface language.
- Added Simplified Chinese to the NSIS installer with automatic language selection based on Windows.
- Fixed authentication connection interruptions being reported as invalid passwords, with one automatic retry for transient interruptions.
<!-- release-notes:en-US:end -->
