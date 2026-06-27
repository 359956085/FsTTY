# FsTTY

FsTTY 是一个 Rust 桌面 SSH 终端应用骨架。当前版本只实现基础架构、模拟数据、Session 管理页面和设置页。

## 开发命令

```bash
npm install
npm run build
npm run tauri dev
```

## 当前范围

- Tauri 2 + React + TypeScript + xterm.js。
- Rust 后端暴露 Session、文件、设备状态、设置命令。
- 前端支持中英文切换。
- 不发起真实 SSH 或 SFTP 网络连接。

