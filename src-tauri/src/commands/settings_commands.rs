use crate::models::{AppError, AppSettings, Language, McpGroupPermission};
use crate::services::AppState;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const MCP_HTTP_CLIENT_HOST_PLACEHOLDER: &str = "<FSTTY_HOST_IP>";
const MCP_HTTP_LISTEN_HOST: &str = "0.0.0.0";

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpClientTarget {
    GenericJson,
    Codex,
    Claude,
    Cursor,
    VsCode,
    GeminiCli,
}

#[tauri::command]
pub fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    let service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;

    Ok(service.get())
}

#[tauri::command]
pub fn open_log_directory(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    std::fs::create_dir_all(&state.log_directory)
        .map_err(|error| AppError::Persistence(format!("无法创建日志目录：{error}")))?;
    app.opener()
        .open_path(state.log_directory.to_string_lossy(), None::<&str>)
        .map_err(|error| AppError::Internal(format!("无法打开日志目录：{error}")))
}

#[tauri::command]
pub fn set_language(
    state: State<'_, AppState>,
    language: Language,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;

    service.set_language(language)
}

#[tauri::command]
pub fn update_app_settings(
    state: State<'_, AppState>,
    auto_update: bool,
    update_proxy: String,
    allow_remote_clipboard_write: bool,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    service.update(auto_update, update_proxy, allow_remote_clipboard_write)
}

#[tauri::command]
pub fn set_ignored_update_version(
    state: State<'_, AppState>,
    version: String,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    service.set_ignored_update_version(version)
}

#[tauri::command]
pub async fn update_mcp_settings(
    state: State<'_, AppState>,
    enabled: bool,
    http_enabled: bool,
    http_port: u16,
    group_permissions: Vec<McpGroupPermission>,
) -> Result<AppSettings, AppError> {
    let previous = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    let http_token = if enabled && http_enabled {
        Some(crate::mcp::get_or_create_http_token(&state).await?)
    } else {
        None
    };
    let settings = {
        let mut service = state
            .settings_service
            .lock()
            .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
        service.update_mcp(enabled, http_enabled, http_port, group_permissions)?
    };
    if settings.mcp_enabled && settings.mcp_http_enabled {
        let token = http_token.expect("启用 HTTP 时已读取令牌");
        let runtime_result =
            if state.mcp_http_runtime.running_port().await == Some(settings.mcp_http_port) {
                if state.mcp_http_runtime.update_token(token.to_string()).await {
                    Ok(())
                } else {
                    state
                        .mcp_http_runtime
                        .start(
                            state.inner().clone(),
                            settings.mcp_http_port,
                            token.to_string(),
                        )
                        .await
                }
            } else {
                state
                    .mcp_http_runtime
                    .start(
                        state.inner().clone(),
                        settings.mcp_http_port,
                        token.to_string(),
                    )
                    .await
            };
        if let Err(error) = runtime_result {
            log::error!(
                "MCP HTTP 服务切换失败：port={}，error={error}",
                settings.mcp_http_port
            );
            let mut service = state
                .settings_service
                .lock()
                .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
            service.update_mcp(
                previous.mcp_enabled,
                previous.mcp_http_enabled,
                previous.mcp_http_port,
                previous.mcp_group_permissions,
            )?;
            return Err(error);
        }
        log::info!("MCP HTTP 服务运行：port={}", settings.mcp_http_port);
    } else {
        state.mcp_http_runtime.stop().await;
        log::info!("MCP HTTP 服务已停止");
    }
    if previous.mcp_enabled != settings.mcp_enabled {
        log::info!("MCP stdio 服务状态变更：enabled={}", settings.mcp_enabled);
    }
    Ok(settings)
}

#[tauri::command]
pub async fn get_mcp_http_client_config(
    state: State<'_, AppState>,
    client_target: McpClientTarget,
) -> Result<String, AppError> {
    let settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    let token = crate::mcp::get_or_create_http_token(&state).await?;
    build_mcp_http_client_config(settings.mcp_http_port, token.as_str(), client_target)
}

fn build_mcp_http_client_config(
    http_port: u16,
    token: &str,
    client_target: McpClientTarget,
) -> Result<String, AppError> {
    let url = format!("http://{MCP_HTTP_CLIENT_HOST_PLACEHOLDER}:{http_port}/mcp");
    let authorization = format!("Bearer {token}");
    match client_target {
        McpClientTarget::Codex => Ok(format!(
            "[mcp_servers.fstty]\nurl = {}\nhttp_headers = {{ Authorization = {} }}",
            toml_string(&url),
            toml_string(&authorization)
        )),
        McpClientTarget::VsCode => pretty_json(&serde_json::json!({
            "servers": {
                "fstty": {
                    "type": "http",
                    "url": url,
                    "headers": { "Authorization": authorization }
                }
            }
        })),
        McpClientTarget::GeminiCli => pretty_json(&serde_json::json!({
            "mcpServers": {
                "fstty": {
                    "httpUrl": url,
                    "headers": { "Authorization": authorization }
                }
            }
        })),
        McpClientTarget::Claude => pretty_json(&serde_json::json!({
            "mcpServers": {
                "fstty": {
                    "type": "http",
                    "url": url,
                    "headers": { "Authorization": authorization }
                }
            }
        })),
        McpClientTarget::GenericJson | McpClientTarget::Cursor => pretty_json(&serde_json::json!({
            "mcpServers": {
                "fstty": {
                    "url": url,
                    "headers": { "Authorization": authorization }
                }
            }
        })),
    }
}

fn mcp_http_listen_address(http_port: u16) -> String {
    format!("http://{MCP_HTTP_LISTEN_HOST}:{http_port}/mcp")
}

#[tauri::command]
pub fn get_mcp_stdio_client_config(client_target: McpClientTarget) -> Result<String, AppError> {
    let executable = std::env::current_exe()
        .map_err(|_| AppError::Internal("无法获取 FsTTY 程序路径".to_owned()))?;
    build_mcp_stdio_client_config(&executable, client_target)
}

#[tauri::command]
pub fn get_mcp_agent_prompt() -> String {
    crate::mcp::mcp_agent_prompt()
}

fn build_mcp_stdio_client_config(
    executable: &Path,
    client_target: McpClientTarget,
) -> Result<String, AppError> {
    let command = executable.to_string_lossy();
    match client_target {
        McpClientTarget::Codex => Ok(format!(
            "[mcp_servers.fstty]\ncommand = {}\nargs = [\"--mcp-stdio\"]",
            toml_string(command.as_ref())
        )),
        McpClientTarget::VsCode => pretty_json(&serde_json::json!({
            "servers": {
                "fstty": {
                    "type": "stdio",
                    "command": command,
                    "args": ["--mcp-stdio"]
                }
            }
        })),
        McpClientTarget::GenericJson
        | McpClientTarget::Claude
        | McpClientTarget::Cursor
        | McpClientTarget::GeminiCli => pretty_json(&serde_json::json!({
            "mcpServers": {
                "fstty": {
                    "command": command,
                    "args": ["--mcp-stdio"]
                }
            }
        })),
    }
}

fn pretty_json(value: &impl Serialize) -> Result<String, AppError> {
    serde_json::to_string_pretty(value)
        .map_err(|_| AppError::Internal("无法生成 MCP 客户端配置".to_owned()))
}

fn toml_string(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '\\' => encoded.push_str("\\\\"),
            '"' => encoded.push_str("\\\""),
            '\n' => encoded.push_str("\\n"),
            '\r' => encoded.push_str("\\r"),
            '\t' => encoded.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(encoded, "\\u{:04X}", character as u32);
            }
            character => encoded.push(character),
        }
    }
    encoded.push('"');
    encoded
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpStatus {
    running: bool,
    address: String,
}

#[tauri::command]
pub async fn get_mcp_http_status(state: State<'_, AppState>) -> Result<McpHttpStatus, AppError> {
    let settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    Ok(McpHttpStatus {
        running: state.mcp_http_runtime.is_running().await,
        address: mcp_http_listen_address(settings.mcp_http_port),
    })
}

#[tauri::command]
pub async fn rotate_mcp_http_token(state: State<'_, AppState>) -> Result<(), AppError> {
    let settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    let token = crate::mcp::rotate_http_token(&state).await?;
    if settings.mcp_enabled && settings.mcp_http_enabled {
        if state.mcp_http_runtime.running_port().await == Some(settings.mcp_http_port) {
            if !state.mcp_http_runtime.update_token(token.to_string()).await {
                state
                    .mcp_http_runtime
                    .start(
                        state.inner().clone(),
                        settings.mcp_http_port,
                        token.to_string(),
                    )
                    .await?;
            }
        } else {
            state
                .mcp_http_runtime
                .start(
                    state.inner().clone(),
                    settings.mcp_http_port,
                    token.to_string(),
                )
                .await?;
        }
    }
    log::info!("MCP HTTP Token 已重置");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_client_config_uses_host_placeholder_and_token() {
        let config =
            build_mcp_http_client_config(37_653, "secret", McpClientTarget::GenericJson).unwrap();
        let value: serde_json::Value = serde_json::from_str(&config).unwrap();

        assert_eq!(
            value["mcpServers"]["fstty"]["url"],
            "http://<FSTTY_HOST_IP>:37653/mcp"
        );
        assert_eq!(
            value["mcpServers"]["fstty"]["headers"]["Authorization"],
            "Bearer secret"
        );
    }

    #[test]
    fn client_configs_follow_agent_specific_shapes() {
        let executable = Path::new(r"C:\Program Files\FsTTY\fstty.exe");
        let vscode = build_mcp_stdio_client_config(executable, McpClientTarget::VsCode).unwrap();
        let vscode: serde_json::Value = serde_json::from_str(&vscode).unwrap();
        assert_eq!(vscode["servers"]["fstty"]["type"], "stdio");

        let gemini =
            build_mcp_http_client_config(37_653, "secret", McpClientTarget::GeminiCli).unwrap();
        let gemini: serde_json::Value = serde_json::from_str(&gemini).unwrap();
        assert_eq!(
            gemini["mcpServers"]["fstty"]["httpUrl"],
            "http://<FSTTY_HOST_IP>:37653/mcp"
        );

        let codex = build_mcp_stdio_client_config(executable, McpClientTarget::Codex).unwrap();
        assert!(codex.contains("[mcp_servers.fstty]"));
        assert!(codex.contains(r#"command = "C:\\Program Files\\FsTTY\\fstty.exe""#));

        let codex_http =
            build_mcp_http_client_config(37_653, "secret", McpClientTarget::Codex).unwrap();
        assert!(codex_http.contains("http_headers = { Authorization = \"Bearer secret\" }"));
    }

    #[test]
    fn http_status_uses_all_ipv4_interfaces() {
        assert_eq!(mcp_http_listen_address(37_653), "http://0.0.0.0:37653/mcp");
    }
}
