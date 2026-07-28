use crate::models::{AppError, AppSettings, Language, McpGroupPermission};
use crate::services::AppState;
use tauri::State;

const MCP_HTTP_CLIENT_HOST_PLACEHOLDER: &str = "<FSTTY_HOST_IP>";
const MCP_HTTP_LISTEN_HOST: &str = "0.0.0.0";

#[tauri::command]
pub fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    let service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;

    Ok(service.get())
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
    } else {
        state.mcp_http_runtime.stop().await;
    }
    Ok(settings)
}

#[tauri::command]
pub async fn get_mcp_http_client_config(state: State<'_, AppState>) -> Result<String, AppError> {
    let settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    let token = crate::mcp::get_or_create_http_token(&state).await?;
    build_mcp_http_client_config(settings.mcp_http_port, token.as_str())
}

fn build_mcp_http_client_config(http_port: u16, token: &str) -> Result<String, AppError> {
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "fstty": {
                "url": format!("http://{MCP_HTTP_CLIENT_HOST_PLACEHOLDER}:{http_port}/mcp"),
                "headers": { "Authorization": format!("Bearer {token}") }
            }
        }
    }))
    .map_err(|_| AppError::Internal("无法生成 MCP 客户端配置".to_owned()))
}

fn mcp_http_listen_address(http_port: u16) -> String {
    format!("http://{MCP_HTTP_LISTEN_HOST}:{http_port}/mcp")
}

#[tauri::command]
pub fn get_mcp_stdio_client_config() -> Result<String, AppError> {
    let executable = std::env::current_exe()
        .map_err(|_| AppError::Internal("无法获取 FsTTY 程序路径".to_owned()))?;
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "fstty": {
                "command": executable,
                "args": ["--mcp-stdio"]
            }
        }
    }))
    .map_err(|_| AppError::Internal("无法生成 MCP stdio 配置".to_owned()))
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_client_config_uses_host_placeholder_and_token() {
        let config = build_mcp_http_client_config(37_653, "secret").unwrap();
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
    fn http_status_uses_all_ipv4_interfaces() {
        assert_eq!(mcp_http_listen_address(37_653), "http://0.0.0.0:37653/mcp");
    }
}
