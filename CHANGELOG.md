# 更新日志 / Changelog

本文件记录 FsTTY 面向用户的重要变化。发布新版本前，需将 `Unreleased` 内容整理到对应版本标题下。

This file records notable user-facing changes to FsTTY. Before publishing, move `Unreleased` items into the matching version section.

## [Unreleased]

<!-- release-notes:zh-CN:start -->
### 简体中文

- 调整更新弹窗底部按钮样式，统一取消、立即更新和重试操作的视觉层级。
- 优化多标签终端的后台渲染、事件监听和输出批处理，降低空闲开销与瞬时内存占用。
- 上传和下载过程中显示基于一秒滑动窗口计算的实时速度。
- 统一保存、连接、确认和更新等按钮的蓝色主操作样式，并按操作语义补充图标。

<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Refined the update dialog footer buttons to give Cancel, Update Now, and Retry a consistent visual hierarchy.
- Optimized background rendering, event listeners, and output batching for multi-tab terminals to reduce idle overhead and transient memory usage.
- Added real-time upload and download speeds calculated over a one-second sliding window.
- Unified blue primary-action styling for save, connect, confirm, and update buttons, with contextual icons.

<!-- release-notes:en-US:end -->

## [0.4.0] - 2026-07-22

<!-- release-notes:zh-CN:start -->
### 简体中文

- 升级到 xterm.js 6，支持 tmux 通过 OSC 52 写入 Windows 剪贴板，并增加可关闭的安全设置。
- 终端支持使用 `Ctrl+C` 将选区复制到 Windows 剪贴板，并使用 `Ctrl+V` 粘贴；
- 修复认证阶段连接中断被误报为密码错误的问题，并对瞬时中断自动重试一次。
- 修复 WebView2 下搜狗输入法按 Shift 切换英文时最终文字未进入终端的问题。
<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English

- Upgraded to xterm.js 6 with tmux OSC 52 clipboard support and an option to disable remote clipboard writes.
- Added `Ctrl+C` for copying terminal selections to the Windows clipboard and `Ctrl+V` for pasting.
- Fixed authentication connection interruptions being reported as invalid passwords, with one automatic retry for transient interruptions.
- Fixed Sogou IME text not reaching the terminal after switching to English with Shift under WebView2.
<!-- release-notes:en-US:end -->
