<img src="./src/assets/brand-icon.png" width="96" alt="FsTTY icon">

# FsTTY

A Windows SSH workspace and secure MCP control plane for AI agents.

[简体中文](README.md) | **English**

[![Latest release](https://img.shields.io/github/v/release/359956085/FsTTY?display_name=tag&label=release)](https://github.com/359956085/FsTTY/releases/latest)
![Version](https://img.shields.io/badge/version-1.1.0-2563EB)
![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
[![MIT License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![FsTTY MCP settings](./doc/assets/fstty-setting-mcp.png)

## Why FsTTY MCP

FsTTY securely exposes your saved SSH sessions to agents such as Codex, Claude, and Cursor. Agents never receive passwords or private keys and can call only explicitly authorized tools within selected session groups.

- **Least privilege**: control access, status reads, file reads, commands, edits, and deletion per session group.
- **Reuse proven SSH capabilities**: FsTTY owns terminals, SFTP, host-key verification, and credential storage.
- **Local and remote access**: use local stdio or Streamable HTTP on a trusted LAN or VPN.
- **One-click agent setup**: detect local agents and merge MCP configuration and global instructions without overwriting unrelated settings.
- **Production diagnostics**: search remote logs, read file windows, execute commands, write atomically, and transfer files under explicit permissions.
- **Auditable operations**: record tool, session, result, and duration, with optional redacted tool inputs.

## MCP Tools

FsTTY currently exposes 16 MCP tools:

| Permission | Tools | Capability |
| --- | --- | --- |
| No session permission | `get_permission_guide` | Returns the permission required by a target tool and the matching UI setup steps |
| Status read | `list_sessions`, `get_device_status` | Discovers authorized sessions and reads CPU, memory, disk, network, OS, and uptime |
| File read | `list_remote_files`, `read_remote_file`, `search_remote_file` | Browses directories, reads file windows, and searches remote logs by keyword |
| Command | `execute_command` | Executes a remote shell command in an authorized session |
| Edit | `write_remote_file`, `create_remote_directory`, `rename_remote_entry`, `move_remote_entry` | Writes files atomically and creates, renames, or moves remote entries |
| Delete | `delete_remote_entry` | Recursively deletes a remote file or directory |
| stdio transfer | `upload_local_file`, `download_remote_file` | Transfers files between MCP client Roots and a remote server |
| HTTP transfer | `create_remote_file_upload_link`, `create_remote_file_download_link` | Issues upload or download links valid for five minutes |

`search_remote_file` scans up to `16 MiB` per call, limits responses to `8 MiB`, supports `0–50` context lines on either side, and continues through `nextOffset`. It is designed for large log files that should not be downloaded or read in full.

## Permissions and Security Boundaries

New session groups are not exposed to MCP. After group access is enabled, status and file reads default to on, while commands, edits, and deletion default to off.

- Saved permissions apply to the next stdio or HTTP request without reconnecting.
- Command execution may bypass edit and deletion restrictions. Grant it only to trusted agents.
- Agents cannot read passwords, private-key content, private-key passphrases, or the HTTP Bearer Token.
- New or changed host keys must be reviewed and accepted in the FsTTY UI.
- File writes use a temporary file and atomic replacement. Upload, rename, and move operations never overwrite an existing target.
- Deletion has no recycle bin and is marked as destructive in the tool metadata.
- Requests fail closed when permission configuration cannot be read or validated.

## stdio and HTTP

| | stdio | Streamable HTTP |
| --- | --- | --- |
| Intended use | Local agents | Agents on a trusted LAN or VPN |
| Address | `fstty.exe --mcp-stdio` | `http://<FSTTY_HOST_IP>:37653/mcp` (default port) |
| Authentication | Local process transport | Bearer Token stored in Windows Credential Manager |
| Local file transfer | MCP client Roots | Five-minute transfer links |
| Network exposure | No listening port | All IPv4 interfaces, plaintext transport |

Never expose the HTTP service to the public internet. `/mcp` targets native MCP clients, rejects requests containing `Origin`, and does not support browser MCP clients or CORS.

A transfer link is its own credential and does not require the Bearer Token. Downloads support a single byte range for resuming. An upload link expires after its first successful upload and never overwrites an existing remote file.

## Quick Start

1. Install FsTTY from [GitHub Releases](https://github.com/359956085/FsTTY/releases/latest).
2. Create an SSH session and complete the initial host-key verification.
3. Open **Settings → MCP** and enable `stdio`.
4. Enable the required session groups under **Permissions**, then grant only the needed tool categories.
5. Select **One-click setup**, choose the installed local agents, and apply the configuration.
6. Ask the agent to call `list_sessions` first and use the returned session ID for other tools.

You can also copy an stdio or HTTP configuration and the agent instructions separately for any other MCP client.

## One-click Local Agent Setup

| Agent | MCP configuration | Global instructions |
| --- | --- | --- |
| Codex | Merged automatically | Merged into `AGENTS.md` |
| Claude | Configured through the official CLI at user scope | Merged into `CLAUDE.md` |
| Cursor | Merged automatically | Copied for manual paste into User Rules |
| VS Code / GitHub Copilot | Merged into the default user profile | Written to a dedicated instructions file |
| Gemini CLI | Merged automatically | Merged into `GEMINI.md` |
| OpenCode | Merged while preserving JSONC comments | Merged into `AGENTS.md` |
| Trae | Merged automatically | Copied for manual paste into User Rules |
| Trae CN | Merged automatically | Copied for manual paste into User Rules |

Automatic setup changes only the FsTTY-owned node or the `fstty:begin/end` marked block. A damaged configuration, an OpenCode dual-file conflict, or one failed agent leaves that agent unchanged while other selected agents continue. Repeated runs update existing FsTTY configuration without duplicate blocks.

## MCP Audit Logs

Audit logs are stored separately under `%APPDATA%\FsTTY\logs\mcp-audit-YYYY-MM-DD.log` and retained for up to 15 days.

- Base records include transport, tool, session, result, and duration.
- **Settings → General → Logs → Log MCP tool inputs** is off by default and applies immediately.
- When enabled, command and path parameters are recorded, but tool output, headers, tokens, and transfer bodies are excluded.
- `write_remote_file.content` is replaced with its UTF-8 byte length and SHA-256. The body is never written to the log.
- Every record uses a conventional single-line text format with safe escaping for strings and control characters.

## Windows SSH Workspace

Beyond MCP, FsTTY is a complete Windows SSH client.

![FsTTY session workspace](./doc/assets/fstty-overview.png)

| Feature | Description |
| --- | --- |
| Session management | Groups, drag ordering, cross-group moves, search, favorites, and multiple tabs |
| SSH authentication | Passwords, private-key files, and pasted private keys, with secrets stored in the system credential vault |
| Remote terminal | xterm.js 6, copy and paste, clear, reconnect, tmux mouse mode, and OSC 52 clipboard support |
| Command history | Shared across sessions with search, upward loading, deduplication, JSON import/export, clear, and Bash/Zsh capture |
| File management | SFTP browse, upload, download, drag-to-move, create, rename, copy path, and recursive delete |
| Device status | CPU and memory trends, disk, network traffic, OS, and uptime |
| Updates | Manual or startup checks, ignored versions, Markdown release notes, and an update proxy |

Selecting a history entry with Enter or the mouse inserts it into the terminal without executing it. The history window supports search, keyboard selection, and persisted drag resizing.

## Download and Install

Open [GitHub Releases](https://github.com/359956085/FsTTY/releases/latest) and download a Windows x64 installer:

- `*-setup.exe` (NSIS) is recommended for most users.
- Use `*.msi` for enterprise or MSI-based deployment.

The NSIS installer supports Simplified Chinese and English and follows the Windows display language. Release packages are not currently signed with Windows Authenticode. If SmartScreen displays a warning, verify that the installer came from this repository's Releases page.

## Current Limitations

- Release packages currently target Windows x64 only.
- HTTP MCP uses plaintext transport and is limited to a trusted LAN or VPN.
- SSH Agent, Pageant, hardware security keys, and SSH certificate authentication are unsupported.
- Local directories cannot yet be uploaded recursively through drag and drop.
- Cursor, Trae, and Trae CN User Rules require a manual paste.

## Local Development

Requirements: Windows, Node.js 20+, Rust stable, and the [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev
```

```bash
npm run verify:all
```

## Acknowledgements

Thanks to the [LINUX DO community](https://linux.do/) for supporting open-source discussion and the growth of this project.

## License

FsTTY is open source under the [MIT License](LICENSE).
