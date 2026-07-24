<img src="./src/assets/brand-icon.png" width="96" alt="FsTTY icon">

# FsTTY

A lightweight SSH terminal and remote file manager built for Windows.

[简体中文](README.md) | **English**

[![Latest release](https://img.shields.io/github/v/release/359956085/FsTTY?display_name=tag&label=release)](https://github.com/359956085/FsTTY/releases/latest)
![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
[![MIT License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![FsTTY session workspace](./doc/assets/fstty-overview.png)

## Overview

FsTTY brings SSH terminals, session management, SFTP file operations, and device status into one desktop workspace. It is designed for Windows users who frequently connect to Linux servers, maintain groups of hosts, or switch between terminals and remote files.

## Features

| Feature | Description |
| --- | --- |
| Session management | Session groups, search, favorites, and a multi-tab workspace |
| SSH authentication | Passwords, private key files, and pasted private key content |
| Host verification | Confirms host key fingerprints on first connection and blocks changed keys |
| Remote terminal | Interactive xterm.js terminal with copy, paste, clear, reconnect, and tmux OSC 52 clipboard support |
| File management | SFTP browsing, uploads, downloads, remote drag-to-move, directory creation, rename, and recursive delete |
| Device status | Shows 10-minute CPU and memory trends, disk, network traffic, OS, and uptime |
| App settings | Chinese/English, remote clipboard control, manual and startup update checks, and an update proxy |

## Download and Install

Open [GitHub Releases](https://github.com/359956085/FsTTY/releases/latest) and download the latest Windows x64 installer:

- The `*-setup.exe` NSIS installer is recommended for most users.
- Use the `*.msi` package for enterprise deployment or MSI-based installation.

The NSIS installer supports Simplified Chinese and English and follows the Windows display language automatically. Other system languages fall back to Simplified Chinese. The MSI installer remains in English to preserve compatibility with existing enterprise deployments and upgrades.

Run the installer and follow the prompts. Current release packages do not use Windows Authenticode code signing, so Windows SmartScreen may display a warning. Verify that the installer came from this repository's Releases page before continuing.

## Usage

### 1. Create a Session

1. Open the Sessions page and select `+` at the top of the session list.
2. Enter the server host, port, and username. If the name is empty, the host address is used automatically. Group is optional.
3. Select an authentication method:
   - **Password**: enter the SSH password.
   - **Private key file**: select a local private key and enter its passphrase when required.
   - **Pasted private key**: paste PEM or OpenSSH private key content.
4. Keep “Save password/private key passphrase” selected to store credentials in the system credential vault. Clear it to be prompted at connection time and use the credential only once.
5. Save the session.

Private key authentication requires a username. File-based keys continue to reference the original local path; select the key again after moving or deleting that file.

### 2. Connect

1. Open a session tab and select “Connect.”
2. On first connection, FsTTY displays the server host key algorithm and SHA-256 fingerprint. Verify it through a trusted channel before selecting “Trust and Connect.”
3. If the server host key changes, FsTTY blocks the connection. After confirming that the server legitimately changed its key, forget the previous record from the session editor and verify the new key.
4. When credentials are not stored, enter the password or private key passphrase in the prompt. You can save it or use it only for the current connection.

### 3. Use the Terminal

- Enter commands in the central terminal area.
- The context menu provides copy, paste, select all, clear, and reconnect actions. With an active selection, press `Ctrl+C` or `Ctrl+Shift+C` to copy it to the Windows clipboard; press `Ctrl+V` to paste. Without a selection, `Ctrl+C` still interrupts the remote command.
- Open multiple session tabs and drag the left or right divider to resize the workspace.

#### tmux Clipboard

- With tmux mouse mode enabled, regular dragging and right-clicks are handled by tmux. Hold the right button, move to a menu item, and release it to run the command. Hold `Shift` while dragging to select text directly in FsTTY, or use `Shift`+right-click to open the FsTTY menu.
- tmux copy mode writes to the Windows clipboard through OSC 52. Run `tmux show -s set-clipboard`; the value should be `external` or `on`.
- Run `tmux info | grep Ms` to verify clipboard support. If it reports `[missing]`, configure `terminal-features` using the [official tmux instructions](https://github.com/tmux/tmux/wiki/Clipboard) and restart the tmux server.

### 4. Manage Remote Files

After connecting to a server with SFTP support, the File Manager panel on the right displays the remote directory.

- Select the upload button to choose one local file.
- Drag multiple regular files into the file list to upload them sequentially to the current directory. Local directories are not uploaded recursively.
- Drag a remote file or directory onto a directory row or path breadcrumb to move it. Existing same-name targets are never overwritten.
- Right-click a file to download, rename, delete, or copy its path.
- Right-click a directory to open, rename, recursively delete, or copy its path.
- Right-click an empty area to create a directory, upload a file, or refresh.

Recursive deletion has no recycle bin or undo. Verify the target path before confirming.

### 5. View Device Status

The Device Status panel displays the operating system, architecture, uptime, disk usage, network upload and download speeds, and the latest 10 minutes of CPU and memory trends when the required remote commands are available. Restricted accounts and minimal systems may provide incomplete information.

### 6. Settings and Updates

The Settings page lets you:

- Switch between Chinese and English. The change applies immediately and is saved.
- Check for updates manually.
- Check for updates at startup. FsTTY still asks for confirmation when an update is available and never installs it silently.
- Configure an empty, `http://`, `https://`, or `socks5://` update proxy.
- Enable or disable remote clipboard writes through OSC 52.

## Security

- When saving is enabled, passwords, pasted private key content, and private key passphrases are stored in the Windows credential vault, not in the regular session configuration.
- Session configuration contains connection details and file-based private key paths, but never returns or displays stored private key content.
- First-time connections require host key confirmation. A changed trusted key blocks the connection.
- Credentials marked for one-time use are limited to the current connection flow.
- When OSC 52 is enabled, remote programs can replace Windows clipboard content. Disable remote clipboard writes in Settings when synchronization is not needed.

## Current Limitations

- Release packages currently target Windows x64 only.
- SSH Agent, Pageant, hardware security keys, and SSH certificate authentication are not supported.
- FsTTY does not generate keys, upload public keys automatically, or provide remote multi-selection.
- Drag-and-drop upload accepts multiple regular files but does not recursively upload local directories.

## Local Development

### Requirements

- Windows
- Node.js 20+
- Rust stable
- [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/)

### Commands

```bash
npm ci
npm run tauri dev
```

```bash
npm run typecheck
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

## Acknowledgements

Thanks to the [LINUX DO community](https://linux.do/) for supporting open-source discussion and the growth of this project.

## License

FsTTY is open source under the [MIT License](LICENSE).
