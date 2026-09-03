use crate::local_agent_setup::{LocalAgentHttpConfig, LocalAgentTransport};
use crate::mcp_runtime::McpStdioLaunchSpec;
use crate::models::{
    AppError, AppSettings, Language, McpCommandPolicy, McpGroupPermission, ShortcutSettings,
    ThemePreference, UpdateSourcePreference,
};
use crate::services::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const MCP_HTTP_CLIENT_HOST_PLACEHOLDER: &str = "<FSTTY_HOST_IP>";
const MCP_HTTP_LISTEN_HOST: &str = "0.0.0.0";
const PROJECT_URL: &str = "https://github.com/359956085/FsTTY";

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpClientTarget {
    GenericJson,
    Codex,
    Claude,
    Cursor,
    VsCode,
    GeminiCli,
    Dsh,
}

#[tauri::command]
pub fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    let settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    hydrate_mcp_permissions(&state, settings)
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
pub fn open_project_link(app: AppHandle) -> Result<(), AppError> {
    app.opener()
        .open_url(PROJECT_URL, None::<&str>)
        .map_err(|error| AppError::Internal(format!("无法打开关于链接：{error}")))
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

    let settings = service.set_language(language)?;
    drop(service);
    hydrate_mcp_permissions(&state, settings)
}

#[tauri::command]
pub fn set_theme(
    state: State<'_, AppState>,
    theme: ThemePreference,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    let settings = service.set_theme(theme)?;
    drop(service);
    hydrate_mcp_permissions(&state, settings)
}

#[tauri::command]
pub fn update_app_settings(
    state: State<'_, AppState>,
    auto_update: bool,
    update_proxy: String,
    allow_remote_clipboard_write: bool,
    update_source: UpdateSourcePreference,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    let settings = service.update(
        auto_update,
        update_proxy,
        allow_remote_clipboard_write,
        update_source,
    )?;
    drop(service);
    hydrate_mcp_permissions(&state, settings)
}

#[tauri::command]
pub fn update_log_settings(
    state: State<'_, AppState>,
    record_mcp_tool_inputs: bool,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    let settings = service.update_log_settings(record_mcp_tool_inputs)?;
    drop(service);
    hydrate_mcp_permissions(&state, settings)
}

#[tauri::command]
pub fn update_shortcut_settings(
    state: State<'_, AppState>,
    shortcuts: ShortcutSettings,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    let settings = service.update_shortcut_settings(shortcuts)?;
    drop(service);
    hydrate_mcp_permissions(&state, settings)
}

#[tauri::command]
pub fn import_mcp_command_policy(path: String) -> Result<McpCommandPolicy, AppError> {
    crate::mcp_command_policy::import_policy(&PathBuf::from(path))
}

#[tauri::command]
pub fn export_mcp_command_policy(path: String, policy: McpCommandPolicy) -> Result<(), AppError> {
    crate::mcp_command_policy::export_policy(&PathBuf::from(path), policy)
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
    let settings = service.set_ignored_update_version(version)?;
    drop(service);
    hydrate_mcp_permissions(&state, settings)
}

#[tauri::command]
pub async fn update_mcp_settings(
    state: State<'_, AppState>,
    enabled: bool,
    http_enabled: bool,
    http_port: u16,
    group_permissions: Vec<McpGroupPermission>,
) -> Result<AppSettings, AppError> {
    let _configuration = state.mcp_configuration_lock.lock().await;
    update_mcp_settings_locked(&state, enabled, http_enabled, http_port, group_permissions).await
}

// 调用者须持有配置事务锁；本地 HTTP 配置与普通设置使用同一套提交和回滚流程。
async fn update_mcp_settings_locked(
    state: &AppState,
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
    let previous_permissions = state
        .mcp_command_policy_service
        .lock()
        .map_err(|_| AppError::Internal("MCP 策略服务锁定失败".to_owned()))?
        .list_permissions()?;
    let permissions = state
        .mcp_command_policy_service
        .lock()
        .map_err(|_| AppError::Internal("MCP 策略服务锁定失败".to_owned()))?
        .replace_all(group_permissions)?;
    let http_token = if enabled && http_enabled {
        match crate::mcp::get_or_create_http_token(state).await {
            Ok(token) => Some(token),
            Err(error) => {
                restore_mcp_permissions(state, previous_permissions.clone())?;
                return Err(error);
            }
        }
    } else {
        None
    };
    let settings_result = {
        let mut service = state
            .settings_service
            .lock()
            .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
        service.update_mcp_transport(enabled, http_enabled, http_port)
    };
    let mut settings = match settings_result {
        Ok(settings) => settings,
        Err(error) => {
            restore_mcp_permissions(state, previous_permissions.clone())?;
            return Err(error);
        }
    };
    settings.mcp_group_permissions = permissions.clone();
    state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .set_mcp_permissions_in_memory(permissions);
    if settings.mcp_enabled && settings.mcp_http_enabled {
        let token = http_token
            .ok_or_else(|| AppError::Internal("启用 MCP HTTP 服务时未能读取访问令牌".to_owned()))?;
        let runtime_result =
            if state.mcp_http_runtime.running_port().await == Some(settings.mcp_http_port) {
                if state.mcp_http_runtime.update_token(token.to_string()).await {
                    Ok(())
                } else {
                    state
                        .mcp_http_runtime
                        .start(state.clone(), settings.mcp_http_port, token.to_string())
                        .await
                }
            } else {
                state
                    .mcp_http_runtime
                    .start(state.clone(), settings.mcp_http_port, token.to_string())
                    .await
            };
        if let Err(error) = runtime_result {
            log::error!(
                "MCP HTTP 服务切换失败：port={}，error={error}",
                settings.mcp_http_port
            );
            restore_mcp_permissions(state, previous_permissions)?;
            state
                .settings_service
                .lock()
                .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
                .update_mcp_transport(
                    previous.mcp_enabled,
                    previous.mcp_http_enabled,
                    previous.mcp_http_port,
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

fn hydrate_mcp_permissions(
    state: &AppState,
    mut settings: AppSettings,
) -> Result<AppSettings, AppError> {
    let permissions = state
        .mcp_command_policy_service
        .lock()
        .map_err(|_| AppError::Internal("MCP 策略服务锁定失败".to_owned()))?
        .list_permissions();
    match permissions {
        Ok(permissions) => settings.mcp_group_permissions = permissions,
        Err(error) => {
            // MCP 数据故障不能阻断通用设置和应用更新；所有 MCP 授权入口仍直接读取数据库并失败关闭。
            log::warn!("读取 MCP 权限失败，通用设置继续使用内存快照：{error}");
        }
    }
    Ok(settings)
}

fn restore_mcp_permissions(
    state: &AppState,
    permissions: Vec<McpGroupPermission>,
) -> Result<(), AppError> {
    let permissions = state
        .mcp_command_policy_service
        .lock()
        .map_err(|_| AppError::Internal("MCP 策略服务锁定失败".to_owned()))?
        .replace_all(permissions)?;
    state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
        .set_mcp_permissions_in_memory(permissions);
    Ok(())
}

#[tauri::command]
pub async fn get_mcp_http_client_config(
    state: State<'_, AppState>,
    client_target: McpClientTarget,
) -> Result<String, AppError> {
    let _configuration = state.mcp_configuration_lock.lock().await;
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
        McpClientTarget::Dsh => build_dsh_http_client_config(&url, &authorization),
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
pub async fn get_mcp_stdio_client_config(
    state: State<'_, AppState>,
    client_target: McpClientTarget,
) -> Result<String, AppError> {
    let app_data_dir = state.app_data_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let executable = std::env::current_exe()
            .map_err(|_| AppError::Internal("无法获取 FsTTY 程序路径".to_owned()))?;
        let launch =
            crate::mcp_runtime::prepare(&app_data_dir, &executable).map_err(AppError::Internal)?;
        build_mcp_stdio_client_config(&launch, client_target)
    })
    .await
    .map_err(|_| AppError::Internal("MCP 运行时准备任务异常终止".to_owned()))?
}

#[tauri::command]
pub fn get_mcp_agent_prompt() -> String {
    crate::mcp::mcp_agent_prompt()
}

#[tauri::command]
pub async fn inspect_local_agent_setup(
    state: State<'_, AppState>,
    transport: Option<LocalAgentTransport>,
) -> Result<Vec<crate::local_agent_setup::LocalAgentCapability>, AppError> {
    let configuration = state.mcp_configuration_lock.clone().lock_owned().await;
    let http = if transport.unwrap_or_default() == LocalAgentTransport::Http {
        let port = state
            .settings_service
            .lock()
            .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
            .get()
            .mcp_http_port;
        // 检测只读系统凭据；尚无令牌时报告待配置，不能顺带开启 HTTP。
        Some(
            LocalAgentHttpConfig::new(port, crate::mcp::get_http_token(&state).await?)
                .map_err(AppError::Validation)?,
        )
    } else {
        None
    };
    let app_data_dir = state.app_data_directory.clone();
    run_local_agent_operation(
        configuration,
        "本地 Agent 检测任务异常终止",
        move || crate::local_agent_setup::inspect_local_agent_setup(&app_data_dir, http),
    )
    .await
}

#[tauri::command]
pub async fn configure_local_agents(
    state: State<'_, AppState>,
    targets: Vec<crate::local_agent_setup::LocalAgentTarget>,
    transport: Option<LocalAgentTransport>,
) -> Result<Vec<crate::local_agent_setup::LocalAgentConfigureResult>, AppError> {
    if targets.is_empty() {
        return Err(AppError::Internal("请至少选择一个本地 Agent".to_owned()));
    }
    let configuration = state.mcp_configuration_lock.clone().lock_owned().await;
    let http = if transport.unwrap_or_default() == LocalAgentTransport::Http {
        let port = state
            .settings_service
            .lock()
            .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?
            .get()
            .mcp_http_port;
        let permissions = state
            .mcp_command_policy_service
            .lock()
            .map_err(|_| AppError::Internal("MCP 策略服务锁定失败".to_owned()))?
            .list_permissions()?;
        let settings = update_mcp_settings_locked(&state, true, true, port, permissions).await?;
        let token = crate::mcp::get_http_token(&state)
            .await?
            .ok_or_else(|| AppError::Internal("启用 MCP HTTP 服务时未能读取访问令牌".to_owned()))?;
        Some(
            LocalAgentHttpConfig::new(settings.mcp_http_port, Some(token))
                .map_err(AppError::Validation)?,
        )
    } else {
        None
    };
    let prompt = crate::mcp::mcp_agent_prompt();
    let app_data_dir = state.app_data_directory.clone();
    run_local_agent_operation(
        configuration,
        "本地 Agent 配置任务异常终止",
        move || {
            crate::local_agent_setup::configure_local_agents(&app_data_dir, targets, &prompt, http)
        },
    )
    .await
}

async fn run_local_agent_operation<T: Send + 'static>(
    configuration: tokio::sync::OwnedMutexGuard<()>,
    join_error: &'static str,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        // IPC 被取消或窗口销毁后，阻塞写入仍持有锁，防止提前修改端口或轮换令牌。
        let _configuration = configuration;
        operation()
    })
    .await
    .map_err(|_| AppError::Internal(join_error.to_owned()))?
    .map_err(AppError::Internal)
}

#[tauri::command]
pub fn get_mcp_permission_catalog() -> Vec<crate::mcp::McpPermissionCatalogEntry> {
    crate::mcp::permission_catalog()
}

fn build_mcp_stdio_client_config(
    launch: &McpStdioLaunchSpec,
    client_target: McpClientTarget,
) -> Result<String, AppError> {
    let command = &launch.command;
    let args = &launch.args;
    match client_target {
        McpClientTarget::Codex => Ok(format!(
            "[mcp_servers.fstty]\ncommand = {}\nargs = [{}]",
            toml_string(command),
            args.iter()
                .map(|argument| toml_string(argument))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        McpClientTarget::VsCode => pretty_json(&serde_json::json!({
            "servers": {
                "fstty": {
                    "type": "stdio",
                    "command": command,
                    "args": args
                }
            }
        })),
        McpClientTarget::Dsh => build_dsh_stdio_client_config(launch),
        McpClientTarget::GenericJson
        | McpClientTarget::Claude
        | McpClientTarget::Cursor
        | McpClientTarget::GeminiCli => pretty_json(&serde_json::json!({
            "mcpServers": {
                "fstty": {
                    "command": command,
                    "args": args
                }
            }
        })),
    }
}

fn build_dsh_stdio_client_config(launch: &McpStdioLaunchSpec) -> Result<String, AppError> {
    let command = yaml_json_value(&launch.command)?;
    let args = yaml_json_value(&launch.args)?;
    Ok(format!(
        "- insert:\n    - id: mcp-fstty\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: fstty\n        transport: stdio\n        command: {command}\n        args: {args}"
    ))
}

fn build_dsh_http_client_config(url: &str, authorization: &str) -> Result<String, AppError> {
    let url = yaml_json_value(url)?;
    let authorization = yaml_json_value(authorization)?;
    Ok(format!(
        "- insert:\n    - id: mcp-fstty\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: fstty\n        transport: streamable-http\n        url: {url}\n        headers:\n          Authorization: {authorization}"
    ))
}

fn yaml_json_value<T: Serialize + ?Sized>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value)
        .map_err(|_| AppError::Internal("无法生成 dsh MCP 客户端配置".to_owned()))
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
    let _configuration = state.mcp_configuration_lock.lock().await;
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
    let _configuration = state.mcp_configuration_lock.lock().await;
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
    use rusqlite::Connection;
    use std::time::Duration;
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("fstty-local-configuration-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }

        fn state(&self) -> AppState {
            let mut state = AppState::new(self.0.clone());
            state.credential_service = crate::services::CredentialService::memory_for_test();
            state
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn 检测令牌只读且重复初始化复用同一令牌() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let _configuration = state.mcp_configuration_lock.lock().await;
        assert!(crate::mcp::get_http_token(&state).await.unwrap().is_none());
        assert!(
            !state
                .settings_service
                .lock()
                .unwrap()
                .get()
                .mcp_http_enabled
        );
        assert!(!state.mcp_http_runtime.is_running().await);

        let first = crate::mcp::get_or_create_http_token(&state).await.unwrap();
        let second = crate::mcp::get_or_create_http_token(&state).await.unwrap();
        assert!(first.as_str() == second.as_str());
        assert!(
            !state
                .settings_service
                .lock()
                .unwrap()
                .get()
                .mcp_http_enabled
        );
        assert!(!state.mcp_http_runtime.is_running().await);
    }

    #[tokio::test]
    async fn 本地http启动失败回滚开关端口与原权限() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let permission: McpGroupPermission = serde_json::from_value(serde_json::json!({
            "groupName": "prod", "enabled": true, "fileWrite": false, "fileDelete": false
        }))
        .unwrap();
        let permissions = state
            .mcp_command_policy_service
            .lock()
            .unwrap()
            .replace_all(vec![permission])
            .unwrap();
        state
            .settings_service
            .lock()
            .unwrap()
            .set_mcp_permissions_in_memory(permissions.clone());
        let previous = state.settings_service.lock().unwrap().get();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let _configuration = state.mcp_configuration_lock.lock().await;
        let error = update_mcp_settings_locked(&state, true, true, port, permissions.clone())
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Connection(message) if message == "MCP HTTP 端口被占用"));
        let actual = state.settings_service.lock().unwrap().get();
        assert_eq!(actual.mcp_enabled, previous.mcp_enabled);
        assert_eq!(actual.mcp_http_enabled, previous.mcp_http_enabled);
        assert_eq!(actual.mcp_http_port, previous.mcp_http_port);
        assert_eq!(actual.mcp_group_permissions, permissions);
        assert_eq!(
            state
                .mcp_command_policy_service
                .lock()
                .unwrap()
                .list_permissions()
                .unwrap(),
            permissions
        );
        assert!(!state.mcp_http_runtime.is_running().await);
        assert!(!directory.0.join("mcp-runtime").exists());
    }

    #[tokio::test]
    async fn 取消窗口请求后阻塞写入仍持锁直到完成() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let guard = state.mcp_configuration_lock.clone().lock_owned().await;
        let previous_port = state.settings_service.lock().unwrap().get().mcp_http_port;
        let previous_token = crate::mcp::get_or_create_http_token(&state).await.unwrap();
        let (started, started_receiver) = tokio::sync::oneshot::channel();
        let (release, release_receiver) = std::sync::mpsc::channel();
        let operation = tokio::spawn(run_local_agent_operation(
            guard,
            "测试任务异常",
            move || {
                started.send(()).unwrap();
                release_receiver
                    .recv_timeout(Duration::from_secs(3))
                    .map_err(|_| "测试写入等待超时".to_owned())
            },
        ));
        started_receiver.await.unwrap();
        operation.abort();
        assert!(operation.await.unwrap_err().is_cancelled());

        let cloned = state.clone();
        let mut next_mutation = tokio::spawn(async move {
            let _configuration = cloned.mcp_configuration_lock.lock().await;
            update_mcp_settings_locked(&cloned, false, false, 42_123, vec![])
                .await
                .unwrap();
            crate::mcp::rotate_http_token(&cloned).await.unwrap()
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(40), &mut next_mutation)
                .await
                .is_err()
        );
        assert_eq!(
            state.settings_service.lock().unwrap().get().mcp_http_port,
            previous_port
        );
        let token = crate::mcp::get_http_token(&state).await.unwrap().unwrap();
        assert!(token.as_str() == previous_token.as_str());
        release.send(()).unwrap();
        let next_token = tokio::time::timeout(Duration::from_secs(3), next_mutation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            state.settings_service.lock().unwrap().get().mcp_http_port,
            42_123
        );
        assert!(next_token.as_str() != previous_token.as_str());
    }

    #[tokio::test]
    async fn 本地配置失败释放串行锁并可重试() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let guard = state.mcp_configuration_lock.clone().lock_owned().await;
        let failed = run_local_agent_operation(guard, "测试任务异常", || {
            Err::<(), _>("模拟配置提交失败".to_owned())
        })
        .await;
        assert!(
            matches!(failed, Err(AppError::Internal(message)) if message == "模拟配置提交失败")
        );
        let guard = state
            .mcp_configuration_lock
            .clone()
            .try_lock_owned()
            .unwrap();
        assert!(run_local_agent_operation(guard, "测试任务异常", || Ok(()))
            .await
            .is_ok());
    }

    fn future_policy_database_state() -> (std::path::PathBuf, AppState) {
        let directory =
            std::env::temp_dir().join(format!("fstty-settings-future-policy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("应创建测试目录");
        let connection =
            Connection::open(directory.join("mcp-command-policy.v1.db")).expect("应创建策略数据库");
        connection
            .pragma_update(None, "user_version", 3)
            .expect("应写入未来版本");
        drop(connection);
        let state = AppState::new(directory.clone());
        (directory, state)
    }

    #[test]
    fn mcp数据库过新时通用设置仍可读取和保存() {
        let (directory, state) = future_policy_database_state();
        let settings = state.settings_service.lock().expect("应锁定设置服务").get();

        let loaded = hydrate_mcp_permissions(&state, settings).expect("通用设置读取不应失败");
        assert!(loaded.auto_update);

        let updated = state
            .settings_service
            .lock()
            .expect("应锁定设置服务")
            .update(
                false,
                "http://127.0.0.1:7890".to_owned(),
                true,
                UpdateSourcePreference::Auto,
            )
            .expect("更新设置应保存");
        let updated = hydrate_mcp_permissions(&state, updated).expect("更新设置返回不应失败");
        assert!(!updated.auto_update);
        assert_eq!(updated.update_proxy, "http://127.0.0.1:7890");

        assert!(state
            .mcp_command_policy_service
            .lock()
            .expect("应锁定 MCP 策略服务")
            .list_permissions()
            .is_err());
        drop(state);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn 项目链接使用固定地址() {
        assert_eq!(PROJECT_URL, "https://github.com/359956085/FsTTY");
    }

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
        let launch = McpStdioLaunchSpec {
            command: r"C:\Windows\System32\cmd.exe".to_owned(),
            args: vec![
                "/d".to_owned(),
                "/s".to_owned(),
                "/c".to_owned(),
                "call".to_owned(),
                r"C:\Users\Test User\AppData\Roaming\FsTTY\mcp-runtime\fstty-mcp.cmd".to_owned(),
            ],
        };
        let vscode = build_mcp_stdio_client_config(&launch, McpClientTarget::VsCode).unwrap();
        let vscode: serde_json::Value = serde_json::from_str(&vscode).unwrap();
        assert_eq!(vscode["servers"]["fstty"]["type"], "stdio");
        assert_eq!(vscode["servers"]["fstty"]["command"], launch.command);
        assert_eq!(
            vscode["servers"]["fstty"]["args"],
            serde_json::json!(launch.args)
        );

        let gemini =
            build_mcp_http_client_config(37_653, "secret", McpClientTarget::GeminiCli).unwrap();
        let gemini: serde_json::Value = serde_json::from_str(&gemini).unwrap();
        assert_eq!(
            gemini["mcpServers"]["fstty"]["httpUrl"],
            "http://<FSTTY_HOST_IP>:37653/mcp"
        );

        let codex = build_mcp_stdio_client_config(&launch, McpClientTarget::Codex).unwrap();
        assert!(codex.contains("[mcp_servers.fstty]"));
        assert!(codex.contains(r#"command = "C:\\Windows\\System32\\cmd.exe""#));
        assert!(codex.contains("fstty-mcp.cmd"));

        let codex_http =
            build_mcp_http_client_config(37_653, "secret", McpClientTarget::Codex).unwrap();
        assert!(codex_http.contains("http_headers = { Authorization = \"Bearer secret\" }"));
    }

    #[test]
    fn dsh_configs_use_profile_patch_shape_and_safe_yaml_values() {
        let launch = McpStdioLaunchSpec {
            command: r"C:\Windows\System32\cmd.exe".to_owned(),
            args: vec![
                "/d".to_owned(),
                "/s".to_owned(),
                "/c".to_owned(),
                "call".to_owned(),
                r"C:\Users\Test User\AppData\Roaming\FsTTY\mcp-runtime\fstty-mcp.cmd".to_owned(),
            ],
        };

        let stdio = build_mcp_stdio_client_config(&launch, McpClientTarget::Dsh).unwrap();
        assert!(stdio.starts_with("- insert:\n"));
        assert!(stdio.contains("id: mcp-fstty"));
        assert!(stdio.contains("name: '@deepseek-ai/dsh-mcp-client'"));
        assert!(stdio.contains("serverName: fstty"));
        assert!(stdio.contains("transport: stdio"));
        assert!(stdio.contains(&format!(
            "command: {}",
            serde_json::to_string(&launch.command).unwrap()
        )));
        assert!(stdio.contains(&format!(
            "args: {}",
            serde_json::to_string(&launch.args).unwrap()
        )));

        let token = r#"secret\"with\\escapes"#;
        let http = build_mcp_http_client_config(37_653, token, McpClientTarget::Dsh).unwrap();
        assert!(http.starts_with("- insert:\n"));
        assert!(http.contains("transport: streamable-http"));
        assert!(http.contains(&format!(
            "url: {}",
            serde_json::to_string("http://<FSTTY_HOST_IP>:37653/mcp").unwrap()
        )));
        assert!(http.contains(&format!(
            "Authorization: {}",
            serde_json::to_string(&format!("Bearer {token}")).unwrap()
        )));
        assert!(!http.contains("transport: sse"));
    }

    #[test]
    fn http_status_uses_all_ipv4_interfaces() {
        assert_eq!(mcp_http_listen_address(37_653), "http://0.0.0.0:37653/mcp");
    }
}
