use crate::mcp_transfer::{http_base_url, McpTransferRuntime};
use crate::models::{AppError, AppSettings, Language, McpGroupPermission, StoredSession};
use crate::services::AppState;
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rmcp::schemars;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, tool::Extension, wrapper::Parameters},
    model::*,
    service::RequestContext,
    tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    fmt::{Display, Formatter},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

const CONNECTION_IDLE: Duration = Duration::from_secs(300);
const MCP_TOKEN_ACCOUNT: &str = "__mcp_http_token";
const MAX_SEARCH_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct McpHttpRuntime {
    state: Arc<Mutex<McpHttpRuntimeState>>,
}

#[derive(Default)]
struct McpHttpRuntimeState {
    running: Option<RunningMcpHttp>,
}

struct RunningMcpHttp {
    port: u16,
    cancellation: CancellationToken,
    bearer_token: Arc<RwLock<Zeroizing<String>>>,
    transfer_runtime: McpTransferRuntime,
}

impl McpHttpRuntime {
    pub async fn stop(&self) {
        if let Some(running) = self.state.lock().await.running.take() {
            running.transfer_runtime.clear().await;
            running.cancellation.cancel();
        }
    }

    pub async fn is_running(&self) -> bool {
        self.state.lock().await.running.is_some()
    }

    pub async fn running_port(&self) -> Option<u16> {
        self.state
            .lock()
            .await
            .running
            .as_ref()
            .map(|running| running.port)
    }

    pub async fn update_token(&self, bearer_token: String) -> bool {
        let running = self.state.lock().await.running.as_ref().map(|running| {
            (
                running.bearer_token.clone(),
                running.transfer_runtime.clone(),
            )
        });
        let Some((token, transfer_runtime)) = running else {
            return false;
        };
        let changed = token.read().await.as_str() != bearer_token;
        if changed {
            *token.write().await = Zeroizing::new(bearer_token);
            transfer_runtime.clear().await;
        }
        true
    }

    pub async fn start(
        &self,
        state: AppState,
        port: u16,
        bearer_token: String,
    ) -> Result<(), AppError> {
        let mut runtime = self.state.lock().await;
        if let Some(running) = runtime.running.as_ref() {
            if running.port == port {
                let changed = running.bearer_token.read().await.as_str() != bearer_token;
                if changed {
                    *running.bearer_token.write().await = Zeroizing::new(bearer_token);
                    running.transfer_runtime.clear().await;
                }
                return Ok(());
            }
        }

        // 先绑定新端口。绑定失败时保留旧监听，避免设置保存失败连带中断现有客户端。
        let listener = tokio::net::TcpListener::bind(http_bind_address(port))
            .await
            .map_err(|_| AppError::Connection("MCP HTTP 端口被占用".to_owned()))?;
        let cancellation = CancellationToken::new();
        let transfer_runtime =
            McpTransferRuntime::new(state.clone(), port, cancellation.child_token());
        let service_state = state.clone();
        let service_transfers = transfer_runtime.clone();
        let service = StreamableHttpService::new(
            move || {
                Ok(McpService::new_http(
                    service_state.clone(),
                    service_transfers.clone(),
                ))
            },
            LocalSessionManager::default().into(),
            http_server_config(cancellation.child_token()),
        );
        let auth_token = Arc::new(RwLock::new(Zeroizing::new(bearer_token)));
        let middleware_token = auth_token.clone();
        let router = transfer_runtime.router().nest_service(
            "/mcp",
            axum::Router::new()
                .fallback_service(service)
                .layer(axum::middleware::from_fn(move |request, next| {
                    let auth_token = middleware_token.clone();
                    async move { authorize_http(request, next, auth_token).await }
                })),
        );
        let previous = runtime.running.replace(RunningMcpHttp {
            port,
            cancellation: cancellation.clone(),
            bearer_token: auth_token,
            transfer_runtime,
        });
        drop(runtime);
        if let Some(previous) = previous {
            previous.transfer_runtime.clear().await;
            previous.cancellation.cancel();
        }
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(cancellation.cancelled_owned())
                .await;
        });
        Ok(())
    }
}

async fn authorize_http(
    request: axum::extract::Request,
    next: axum::middleware::Next,
    token: Arc<RwLock<Zeroizing<String>>>,
) -> axum::response::Response {
    let validation = {
        let expected = token.read().await;
        validate_http_headers(request.headers(), expected.as_str())
    };
    if let Err(status) = validation {
        let message = if status == StatusCode::FORBIDDEN {
            "不支持浏览器来源请求"
        } else {
            "未授权"
        };
        return (status, message).into_response();
    }
    next.run(request).await
}

fn http_bind_address(port: u16) -> std::net::SocketAddr {
    std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port))
}

fn http_server_config(cancellation_token: CancellationToken) -> StreamableHttpServerConfig {
    // rmcp 默认只接受回环 Host。远程模式的地址无法预先固定，故由令牌和 Origin 中间件承担访问保护。
    StreamableHttpServerConfig::default()
        .disable_allowed_hosts()
        .with_cancellation_token(cancellation_token)
}

fn validate_http_headers(headers: &HeaderMap, expected_token: &str) -> Result<(), StatusCode> {
    // HTTP 传输仅面向原生 MCP 客户端。拒绝所有浏览器来源，避免 DNS 重绑定攻击。
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == expected_token);
    if authorized {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

pub async fn get_or_create_http_token(state: &AppState) -> Result<Zeroizing<String>, AppError> {
    if let Some(token) = state.credential_service.get(MCP_TOKEN_ACCOUNT).await? {
        return Ok(token);
    }
    rotate_http_token(state).await
}

pub async fn rotate_http_token(state: &AppState) -> Result<Zeroizing<String>, AppError> {
    let token = Zeroizing::new(format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ));
    state
        .credential_service
        .set(MCP_TOKEN_ACCOUNT, Zeroizing::new(token.to_string()))
        .await?;
    Ok(token)
}

pub async fn run_stdio(app_data_dir: std::path::PathBuf) -> Result<(), String> {
    use rmcp::{transport::stdio, ServiceExt};
    let state = AppState::new(app_data_dir);
    if !state
        .settings_service
        .lock()
        .map_err(|_| "设置服务锁定失败")?
        .get()
        .mcp_enabled
    {
        return Err("MCP 服务未启用".to_owned());
    }
    let service = McpService::new(state, "stdio")
        .serve(stdio())
        .await
        .map_err(|error| error.to_string())?;
    service
        .waiting()
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[derive(Clone)]
pub struct McpService {
    state: AppState,
    connections: Arc<Mutex<HashMap<String, CachedConnection>>>,
    transport: &'static str,
    transfer_runtime: Option<McpTransferRuntime>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

struct CachedConnection {
    connection_id: String,
    last_used: Instant,
}

struct AuditGuard {
    service: crate::services::McpAuditService,
    transport: &'static str,
    tool: &'static str,
    session_id: Option<String>,
    started: Instant,
    succeeded: bool,
}

impl AuditGuard {
    fn succeed(mut self) {
        self.succeeded = true;
    }
}

impl Drop for AuditGuard {
    fn drop(&mut self) {
        self.service.record(
            self.transport,
            self.tool,
            self.session_id.as_deref(),
            if self.succeeded { "success" } else { "error" },
            self.started.elapsed(),
        );
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SessionArgs {
    session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListFilesArgs {
    session_id: String,
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadFileArgs {
    session_id: String,
    path: String,
    #[serde(default)]
    offset: u64,
    #[serde(default = "default_read_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SearchRemoteFileArgs {
    /// FsTTY 会话 ID。
    session_id: String,
    /// 要扫描的远程普通文件绝对路径。
    path: String,
    /// 查询文本，长度为 1–1024 字节，不能包含换行或控制字符。
    #[schemars(length(min = 1, max = 1024))]
    query: String,
    /// 扫描起始字节偏移；启用 tail 时必须为 0。
    #[serde(default)]
    offset: u64,
    /// 是否从文件尾部向前取一个扫描窗口。
    #[serde(default)]
    tail: bool,
    /// 单次扫描字节数，范围为 1–16 MiB。
    #[serde(default = "default_search_scan_bytes")]
    #[schemars(range(min = 1, max = 16_777_216))]
    scan_bytes: usize,
    /// 是否区分查询文本的大小写。
    #[serde(default)]
    case_sensitive: bool,
    /// 每个匹配项之前返回的上下文行数，范围为 0–50。
    #[serde(default)]
    #[schemars(range(min = 0, max = 50))]
    before_lines: usize,
    /// 每个匹配项之后返回的上下文行数，范围为 0–50。
    #[serde(default)]
    #[schemars(range(min = 0, max = 50))]
    after_lines: usize,
    /// 最多返回的匹配项数量，范围为 1–50。
    #[serde(default = "default_search_max_matches")]
    #[schemars(range(min = 1, max = 50))]
    max_matches: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileSearchMatch {
    byte_offset: u64,
    line: String,
    before: Vec<String>,
    after: Vec<String>,
    line_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileSearchResult {
    matches: Vec<RemoteFileSearchMatch>,
    start_offset: u64,
    next_offset: u64,
    file_size: u64,
    scanned_bytes: usize,
    end_of_file: bool,
    match_limit_reached: bool,
    lossy_decoding: bool,
    output_truncated: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CommandArgs {
    session_id: String,
    command: String,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WriteFileArgs {
    session_id: String,
    path: String,
    content: String,
    #[serde(default)]
    base64: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateDirectoryArgs {
    session_id: String,
    parent_path: String,
    name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenameArgs {
    session_id: String,
    path: String,
    new_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    session_id: String,
    source_path: String,
    target_directory: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DeleteArgs {
    session_id: String,
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LocalTransferArgs {
    session_id: String,
    local_path: String,
    remote_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DownloadLinkArgs {
    session_id: String,
    remote_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UploadLinkArgs {
    session_id: String,
    remote_directory: String,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PermissionGuideArgs {
    #[serde(default)]
    tool_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeSession {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    group: String,
    tags: Vec<String>,
    auth_kind: &'static str,
}

#[derive(Debug)]
struct GuidePermission {
    key: &'static str,
    zh_name: &'static str,
    en_name: &'static str,
    tools: &'static [&'static str],
    zh_warning: Option<&'static str>,
    en_warning: Option<&'static str>,
}

const GUIDE_PERMISSIONS: &[GuidePermission] = &[
    GuidePermission {
        key: "enabled",
        zh_name: "分组访问",
        en_name: "Group access",
        tools: &[],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "sessionRead",
        zh_name: "会话与状态读取",
        en_name: "Session and status read",
        tools: &["list_sessions", "get_device_status"],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "fileRead",
        zh_name: "远程文件读取",
        en_name: "Remote file read",
        tools: &[
            "list_remote_files",
            "read_remote_file",
            "search_remote_file",
            "download_remote_file",
            "create_remote_file_download_link",
        ],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "commandExecute",
        zh_name: "命令执行",
        en_name: "Command execution",
        tools: &["execute_command"],
        zh_warning: Some("命令执行属于高风险权限，可绕过文件编辑和删除限制。"),
        en_warning: Some(
            "Command execution is high risk and can bypass file editing and deletion restrictions.",
        ),
    },
    GuidePermission {
        key: "fileWrite",
        zh_name: "文件编辑",
        en_name: "File editing",
        tools: &[
            "write_remote_file",
            "upload_local_file",
            "create_remote_directory",
            "rename_remote_entry",
            "move_remote_entry",
            "create_remote_file_upload_link",
        ],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "fileDelete",
        zh_name: "文件删除",
        en_name: "File deletion",
        tools: &["delete_remote_entry"],
        zh_warning: Some("文件删除属于破坏性操作，远程删除无法撤销。"),
        en_warning: Some("File deletion is destructive and cannot be undone remotely."),
    },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionGuideEntry {
    permission_key: &'static str,
    permission_name: &'static str,
    tools: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionGuideResponse {
    locale: &'static str,
    settings_path: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_key: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_name: Option<&'static str>,
    steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<&'static str>,
    permissions: Vec<PermissionGuideEntry>,
}

impl GuidePermission {
    fn name(&self, language: &Language) -> &'static str {
        if matches!(language, Language::EnUs) {
            self.en_name
        } else {
            self.zh_name
        }
    }

    fn warning(&self, language: &Language) -> Option<&'static str> {
        if matches!(language, Language::EnUs) {
            self.en_warning
        } else {
            self.zh_warning
        }
    }
}

fn guide_permission_for_tool(tool_name: &str) -> Option<&'static GuidePermission> {
    GUIDE_PERMISSIONS
        .iter()
        .find(|permission| permission.tools.contains(&tool_name))
}

fn supported_guide_tools() -> Vec<&'static str> {
    GUIDE_PERMISSIONS
        .iter()
        .flat_map(|permission| permission.tools.iter().copied())
        .collect()
}

pub(crate) fn mcp_agent_prompt() -> String {
    let tool_groups = GUIDE_PERMISSIONS
        .iter()
        .filter(|permission| !permission.tools.is_empty())
        .map(|permission| {
            format!(
                "- {} ({}): {}",
                permission.en_name,
                permission.key,
                permission.tools.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<!-- fstty:begin -->

Use FsTTY MCP:
- Call list_sessions first to discover available sessions.
- Use get_device_status for status; list_remote_files, read_remote_file, and search_remote_file for files and logs.
- execute_command runs remote shell commands when commandExecute permission is enabled.
- get_permission_guide returns FsTTY permission setup steps for a tool.
- stdio local transfers require MCP client Roots. HTTP transfers use create_remote_file_upload_link or create_remote_file_download_link; links expire after five minutes.
- Host-key and credential issues are handled in FsTTY.
- Tool parameters are defined by live MCP tool schemas.

Permission and tool mapping:
{tool_groups}
- Guide: get_permission_guide

<!-- fstty:end -->"#
    )
}

fn permission_guide_entry(
    permission: &'static GuidePermission,
    language: &Language,
) -> PermissionGuideEntry {
    PermissionGuideEntry {
        permission_key: permission.key,
        permission_name: permission.name(language),
        tools: permission.tools,
        warning: permission.warning(language),
    }
}

fn permission_guide_response(
    language: &Language,
    tool_name: Option<String>,
) -> Result<PermissionGuideResponse, String> {
    let target_permission = tool_name
        .as_deref()
        .map(|tool_name| {
            guide_permission_for_tool(tool_name)
                .ok_or_else(|| permission_guide_unknown_tool(language))
        })
        .transpose()?;
    let english = matches!(language, Language::EnUs);
    let settings_path = if english {
        "Settings > MCP"
    } else {
        "设置 > MCP"
    };
    let mut steps = if english {
        vec![
            "Open Settings > MCP in FsTTY.".to_owned(),
            "Find the group that contains the target session.".to_owned(),
            "Enable Group access.".to_owned(),
        ]
    } else {
        vec![
            "打开 FsTTY 的“设置 > MCP”。".to_owned(),
            "找到目标会话所属分组。".to_owned(),
            "开启“分组访问”。".to_owned(),
        ]
    };
    match target_permission {
        Some(permission) => {
            steps.push(if english {
                format!("Enable {}.", permission.name(language))
            } else {
                format!("开启“{}”。", permission.name(language))
            });
        }
        None => steps.push(if english {
            "Enable the permissions required by the task.".to_owned()
        } else {
            "按任务需要开启对应权限。".to_owned()
        }),
    }
    steps.push(if english {
        "Select Save MCP settings.".to_owned()
    } else {
        "点击“保存 MCP 设置”。".to_owned()
    });
    let permissions = match target_permission {
        Some(permission) => vec![
            permission_guide_entry(&GUIDE_PERMISSIONS[0], language),
            permission_guide_entry(permission, language),
        ],
        None => GUIDE_PERMISSIONS
            .iter()
            .map(|permission| permission_guide_entry(permission, language))
            .collect(),
    };
    Ok(PermissionGuideResponse {
        locale: if english { "en-US" } else { "zh-CN" },
        settings_path,
        target_tool: tool_name,
        permission_key: target_permission.map(|permission| permission.key),
        permission_name: target_permission.map(|permission| permission.name(language)),
        steps,
        warning: target_permission.and_then(|permission| permission.warning(language)),
        permissions,
    })
}

fn permission_guide_unknown_tool(language: &Language) -> String {
    let tools = supported_guide_tools().join(", ");
    if matches!(language, Language::EnUs) {
        format!("Unknown tool. Supported tools: {tools}")
    } else {
        format!("未知工具。支持的工具：{tools}")
    }
}

fn default_timeout() -> u64 {
    60
}

fn default_read_limit() -> usize {
    1024 * 1024
}

fn default_search_scan_bytes() -> usize {
    4 * 1024 * 1024
}

fn default_search_max_matches() -> usize {
    50
}

fn validate_search_remote_file_args(args: &SearchRemoteFileArgs) -> Result<(), &'static str> {
    if args.query.is_empty()
        || args.query.len() > 1_024
        || args.query.chars().any(|character| {
            matches!(character, '\0' | '\r' | '\n') || character.is_control() && character != '\t'
        })
    {
        return Err("查询文本必须为 1 到 1024 字节，且不能包含换行或控制字符");
    }
    if args.scan_bytes == 0 || args.scan_bytes > 16 * 1024 * 1024 {
        return Err("scanBytes 必须在 1 字节到 16 MiB 之间");
    }
    if args.before_lines > 50 || args.after_lines > 50 {
        return Err("beforeLines 和 afterLines 必须在 0 到 50 之间");
    }
    if args.max_matches == 0 || args.max_matches > 50 {
        return Err("maxMatches 必须在 1 到 50 之间");
    }
    Ok(())
}

struct RemoteFileSearchInput<'a> {
    content: &'a [u8],
    start_offset: u64,
    file_size: u64,
    starts_at_line_boundary: bool,
    window_reaches_end: bool,
    query: &'a str,
    case_sensitive: bool,
    before_lines: usize,
    after_lines: usize,
    max_matches: usize,
}

fn search_remote_text(input: RemoteFileSearchInput<'_>) -> RemoteFileSearchResult {
    const MAX_OUTPUT_LINE_CHARS: usize = 2_048;

    let normalized_query = (!input.case_sensitive).then(|| input.query.to_lowercase());
    let mut matches: Vec<RemoteFileSearchMatch> = Vec::new();
    let mut before = VecDeque::with_capacity(input.before_lines);
    let mut pending_after: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0;
    let mut lossy_decoding = false;
    let mut match_limit_reached = false;

    // 扫描窗口可能从一行中间开始；丢弃残行，避免返回误导性匹配。
    if !input.starts_at_line_boundary {
        match input.content.iter().position(|byte| *byte == b'\n') {
            Some(position) => cursor = position + 1,
            None => {
                return RemoteFileSearchResult {
                    matches,
                    start_offset: input.start_offset,
                    next_offset: input
                        .start_offset
                        .saturating_add(input.content.len() as u64),
                    file_size: input.file_size,
                    scanned_bytes: input.content.len(),
                    end_of_file: input.window_reaches_end,
                    match_limit_reached,
                    lossy_decoding,
                    output_truncated: false,
                };
            }
        }
    }

    while cursor < input.content.len() {
        let remaining = &input.content[cursor..];
        let newline = remaining.iter().position(|byte| *byte == b'\n');
        if newline.is_none() && !input.window_reaches_end {
            break;
        }
        let line_length = newline.unwrap_or(remaining.len());
        let next_cursor = cursor
            .saturating_add(line_length)
            .saturating_add(usize::from(newline.is_some()));
        let mut line_bytes = &input.content[cursor..cursor + line_length];
        if line_bytes.last() == Some(&b'\r') {
            line_bytes = &line_bytes[..line_bytes.len() - 1];
        }
        lossy_decoding |= std::str::from_utf8(line_bytes).is_err();
        let full_line = String::from_utf8_lossy(line_bytes);
        let preview: String = full_line.chars().take(MAX_OUTPUT_LINE_CHARS).collect();
        let line_truncated = full_line.chars().count() > MAX_OUTPUT_LINE_CHARS;

        for (match_index, remaining_lines) in &mut pending_after {
            if *remaining_lines > 0 {
                matches[*match_index].after.push(preview.clone());
                *remaining_lines -= 1;
            }
        }
        pending_after.retain(|(_, remaining_lines)| *remaining_lines > 0);

        if !match_limit_reached {
            let matched = if let Some(normalized_query) = normalized_query.as_deref() {
                full_line.to_lowercase().contains(normalized_query)
            } else {
                full_line.contains(input.query)
            };
            if matched {
                let match_index = matches.len();
                matches.push(RemoteFileSearchMatch {
                    byte_offset: input.start_offset.saturating_add(cursor as u64),
                    line: preview.clone(),
                    before: before.iter().cloned().collect(),
                    after: Vec::with_capacity(input.after_lines),
                    line_truncated,
                });
                if input.after_lines > 0 {
                    pending_after.push((match_index, input.after_lines));
                }
                if matches.len() >= input.max_matches {
                    match_limit_reached = true;
                }
            }
        }

        if input.before_lines > 0 {
            before.push_back(preview);
            while before.len() > input.before_lines {
                before.pop_front();
            }
        }
        cursor = next_cursor;
        if match_limit_reached && pending_after.is_empty() {
            break;
        }
    }

    let next_offset = input.start_offset.saturating_add(cursor as u64);
    RemoteFileSearchResult {
        matches,
        start_offset: input.start_offset,
        next_offset,
        file_size: input.file_size,
        scanned_bytes: cursor,
        end_of_file: next_offset >= input.file_size,
        match_limit_reached,
        lossy_decoding,
        output_truncated: false,
    }
}

fn search_json_result(mut result: RemoteFileSearchResult) -> CallToolResult {
    loop {
        let Ok(text) = serde_json::to_string(&result) else {
            return tool_error("无法序列化远程文件搜索结果");
        };
        let response = CallToolResult::success(vec![ContentBlock::text(text)]);
        if serde_json::to_vec(&response).is_ok_and(|bytes| bytes.len() <= MAX_SEARCH_RESPONSE_BYTES)
        {
            return response;
        }

        // 从尾部裁剪完整匹配项，确保续扫偏移始终落在首个未返回的匹配处。
        let Some(removed) = result.matches.pop() else {
            return tool_error("远程文件搜索结果超过 8 MiB 输出限制");
        };
        result.output_truncated = true;
        result.next_offset = removed.byte_offset;
        result.end_of_file = false;
    }
}

#[tool_router]
impl McpService {
    pub fn new(state: AppState, transport: &'static str) -> Self {
        let mut tool_router = Self::tool_router();
        tool_router.remove_route("create_remote_file_download_link");
        tool_router.remove_route("create_remote_file_upload_link");
        Self {
            state,
            connections: Arc::new(Mutex::new(HashMap::new())),
            transport,
            transfer_runtime: None,
            tool_router,
        }
    }

    fn new_http(state: AppState, transfer_runtime: McpTransferRuntime) -> Self {
        let mut tool_router = Self::tool_router();
        tool_router.remove_route("upload_local_file");
        tool_router.remove_route("download_remote_file");
        Self {
            state,
            connections: Arc::new(Mutex::new(HashMap::new())),
            transport: "http",
            transfer_runtime: Some(transfer_runtime),
            tool_router,
        }
    }

    fn audit(&self, tool: &'static str, session_id: Option<&str>) -> AuditGuard {
        AuditGuard {
            service: self.state.mcp_audit_service.clone(),
            transport: self.transport,
            tool,
            session_id: session_id.map(ToOwned::to_owned),
            started: Instant::now(),
            succeeded: false,
        }
    }

    fn operation_lock(
        &self,
        session_id: &str,
    ) -> Result<crate::services::McpOperationLock, McpError> {
        self.state
            .mcp_operation_lock_service
            .try_lock(session_id)
            .map_err(|message| McpError::invalid_request(message, None))
    }

    #[tool(
        description = "按 FsTTY 当前语言返回 MCP 工具所需权限和设置步骤",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn get_permission_guide(
        &self,
        Parameters(args): Parameters<PermissionGuideArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("get_permission_guide", None);
        let settings = self.settings()?;
        let response = permission_guide_response(&settings.language, args.tool_name)
            .map_err(|message| McpError::invalid_params(message, None))?;
        audit.succeed();
        Ok(structured_json_result(&response))
    }

    #[tool(
        description = "列出已授权的 FsTTY SSH 会话，不返回凭据或私钥路径",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn list_sessions(&self) -> Result<CallToolResult, McpError> {
        let audit = self.audit("list_sessions", None);
        let settings = self.settings()?;
        if !settings.mcp_enabled {
            return Ok(tool_error("MCP 服务未启用"));
        }
        let groups = self
            .state
            .session_service
            .lock()
            .await
            .list_groups(&self.state.credential_service)
            .await
            .map_err(mcp_error)?;
        let sessions = groups
            .into_iter()
            .filter(|group| {
                permission(&settings.mcp_group_permissions, &group.name)
                    .is_some_and(|permission| permission.session_read)
            })
            .flat_map(|group| {
                group.sessions.into_iter().map(move |session| SafeSession {
                    id: session.id,
                    name: session.name,
                    host: session.host,
                    port: session.port,
                    username: session.username,
                    group: group.name.clone(),
                    tags: session.tags,
                    auth_kind: match session.auth {
                        crate::models::SessionAuth::Password => "password",
                        crate::models::SessionAuth::PrivateKey { .. } => "privateKey",
                    },
                })
            })
            .collect::<Vec<_>>();
        audit.succeed();
        Ok(json_result(&sessions))
    }

    #[tool(
        description = "读取远程主机 CPU、内存、磁盘、网络和系统状态",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn get_device_status(
        &self,
        Parameters(args): Parameters<SessionArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("get_device_status", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::SessionRead)
            .await?;
        let status = self
            .state
            .device_service
            .status(&self.state.connection_manager, &connection)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&status))
    }

    #[tool(
        description = "列出远程目录",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn list_remote_files(
        &self,
        Parameters(args): Parameters<ListFilesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("list_remote_files", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileRead)
            .await?;
        let files = self
            .state
            .connection_manager
            .list_files(&connection, &args.path)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&files))
    }

    #[tool(
        description = "分页读取远程文件，非 UTF-8 内容使用 Base64 返回",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn read_remote_file(
        &self,
        Parameters(args): Parameters<ReadFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("read_remote_file", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileRead)
            .await?;
        let bytes = self
            .state
            .connection_manager
            .read_remote_file(&connection, &args.path, args.offset, args.limit)
            .await
            .map_err(mcp_error)?;
        let value = match String::from_utf8(bytes.clone()) {
            Ok(text) => json!({"encoding": "utf8", "content": text, "bytes": bytes.len()}),
            Err(_) => {
                json!({"encoding": "base64", "content": BASE64_STANDARD.encode(&bytes), "bytes": bytes.len()})
            }
        };
        audit.succeed();
        Ok(json_result(&value))
    }

    #[tool(
        description = "按关键词扫描远程文本文件；beforeLines/afterLines 为 0–50，maxMatches 为 1–50，单行最多 2048 字符，单次最多扫描 16 MiB，响应最多 8 MiB",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn search_remote_file(
        &self,
        Parameters(args): Parameters<SearchRemoteFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        validate_search_remote_file_args(&args)
            .map_err(|message| McpError::invalid_params(message, None))?;

        let audit = self.audit("search_remote_file", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileRead)
            .await?;
        let window = self
            .state
            .connection_manager
            .read_remote_file_window(
                &connection,
                &args.path,
                args.offset,
                args.tail,
                args.scan_bytes,
            )
            .await
            .map_err(mcp_error)?;
        let result = search_remote_text(RemoteFileSearchInput {
            content: &window.content,
            start_offset: window.offset,
            file_size: window.file_size,
            starts_at_line_boundary: window.starts_at_line_boundary,
            window_reaches_end: window.end_of_file,
            query: &args.query,
            case_sensitive: args.case_sensitive,
            before_lines: args.before_lines,
            after_lines: args.after_lines,
            max_matches: args.max_matches,
        });
        audit.succeed();
        Ok(search_json_result(result))
    }

    #[tool(
        description = "执行非交互式远程 Shell 命令",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    async fn execute_command(
        &self,
        Parameters(args): Parameters<CommandArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("execute_command", Some(&args.session_id));
        if args.command.is_empty() || args.command.len() > 64 * 1024 {
            return Ok(tool_error("命令为空或过长"));
        }
        let connection = self
            .authorized_connection(&args.session_id, Permission::Command)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        let started = Instant::now();
        let output = self
            .state
            .connection_manager
            .exec_command(
                &connection,
                &args.command,
                Duration::from_secs(args.timeout_seconds.clamp(1, 1800)),
            )
            .await
            .map_err(mcp_error)?;
        let result = json_result(&json!({
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
            "exitCode": output.exit_code,
            "durationMs": started.elapsed().as_millis(),
            "truncated": output.truncated,
        }));
        audit.succeed();
        Ok(result)
    }

    #[tool(
        description = "原子创建远程文件；目标已存在时拒绝覆盖",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn write_remote_file(
        &self,
        Parameters(args): Parameters<WriteFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("write_remote_file", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileWrite)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        let content = if args.base64 {
            BASE64_STANDARD
                .decode(args.content.as_bytes())
                .map_err(|_| McpError::invalid_params("Base64 内容无效", None))?
        } else {
            args.content.into_bytes()
        };
        self.state
            .connection_manager
            .write_remote_file_atomic(&connection, &args.path, &content)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"written": content.len()})))
    }

    #[tool(
        description = "创建远程目录",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn create_remote_directory(
        &self,
        Parameters(args): Parameters<CreateDirectoryArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("create_remote_directory", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileWrite)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        self.state
            .connection_manager
            .create_remote_directory(&connection, &args.parent_path, &args.name)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"ok": true})))
    }

    #[tool(
        description = "重命名远程文件或目录",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn rename_remote_entry(
        &self,
        Parameters(args): Parameters<RenameArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("rename_remote_entry", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileWrite)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        self.state
            .connection_manager
            .rename_remote_entry(&connection, &args.path, &args.new_name)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"ok": true})))
    }

    #[tool(
        description = "移动远程文件或目录",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn move_remote_entry(
        &self,
        Parameters(args): Parameters<MoveArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("move_remote_entry", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileWrite)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        self.state
            .connection_manager
            .move_remote_entry(&connection, &args.source_path, &args.target_directory)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"ok": true})))
    }

    #[tool(
        description = "递归删除远程文件或目录",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    async fn delete_remote_entry(
        &self,
        Parameters(args): Parameters<DeleteArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("delete_remote_entry", Some(&args.session_id));
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileDelete)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        self.state
            .connection_manager
            .delete_remote_entry(&connection, &args.path)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"ok": true})))
    }

    #[tool(
        description = "为远程普通文件创建 5 分钟有效的 HTTP 下载链接；链接本身即凭据，支持单区间断点续传",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn create_remote_file_download_link(
        &self,
        Parameters(args): Parameters<DownloadLinkArgs>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("create_remote_file_download_link", Some(&args.session_id));
        let runtime = self
            .transfer_runtime
            .as_ref()
            .ok_or_else(|| McpError::invalid_request("当前传输不支持 HTTP 下载链接", None))?;
        let base_url = http_base_url(&parts.headers, runtime.port())
            .map_err(|error| McpError::invalid_request(error.to_string(), None))?;
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileRead)
            .await?;
        let (remote_path, size) = self
            .state
            .connection_manager
            .remote_file_info(&connection, &args.remote_path)
            .await
            .map_err(mcp_error)?;
        let file_name = remote_file_name(&remote_path)?;
        let link = runtime
            .issue_download(&base_url, args.session_id, remote_path, file_name.clone())
            .await
            .map_err(mcp_error)?;
        let structured = json!({
            "downloadUrl": link.url,
            "fileName": file_name,
            "size": size,
            "expiresInSeconds": link.expires_in_seconds,
            "expiresAtUnixMs": link.expires_at_unix_ms,
            "supportsSingleRange": true,
        });
        let resource = Resource::new(
            structured["downloadUrl"]
                .as_str()
                .expect("下载地址应为字符串"),
            structured["fileName"].as_str().expect("文件名应为字符串"),
        )
        .with_title("FsTTY 远程文件下载")
        .with_description("5 分钟有效；链接本身即凭据")
        .with_mime_type("application/octet-stream")
        .with_size(size);
        let message = format!(
            "下载链接（5 分钟有效，可顺序重试）：{}\n链接本身即凭据，请勿转发。",
            structured["downloadUrl"]
                .as_str()
                .expect("下载地址应为字符串")
        );
        audit.succeed();
        Ok(transfer_link_result(resource, message, structured))
    }

    #[tool(
        description = "为远程目录创建 5 分钟有效的一次性 HTTP 上传链接；可打开网页选择文件，或向文件名路径执行原始 PUT",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn create_remote_file_upload_link(
        &self,
        Parameters(args): Parameters<UploadLinkArgs>,
        Extension(parts): Extension<axum::http::request::Parts>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("create_remote_file_upload_link", Some(&args.session_id));
        let runtime = self
            .transfer_runtime
            .as_ref()
            .ok_or_else(|| McpError::invalid_request("当前传输不支持 HTTP 上传链接", None))?;
        let base_url = http_base_url(&parts.headers, runtime.port())
            .map_err(|error| McpError::invalid_request(error.to_string(), None))?;
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileWrite)
            .await?;
        let remote_directory = self
            .state
            .connection_manager
            .remote_directory_path(&connection, &args.remote_directory)
            .await
            .map_err(mcp_error)?;
        let link = runtime
            .issue_upload(&base_url, args.session_id, remote_directory.clone())
            .await
            .map_err(mcp_error)?;
        let put_url_template = format!("{}/{{percentEncodedFileName}}", link.url);
        let structured = json!({
            "uploadPageUrl": link.url,
            "putUrlTemplate": put_url_template,
            "remoteDirectory": remote_directory,
            "expiresInSeconds": link.expires_in_seconds,
            "expiresAtUnixMs": link.expires_at_unix_ms,
            "overwrite": false,
        });
        let resource = Resource::new(
            structured["uploadPageUrl"]
                .as_str()
                .expect("上传地址应为字符串"),
            "FsTTY 文件上传",
        )
        .with_title("FsTTY 一次性文件上传")
        .with_description("5 分钟有效；首次成功后立即失效")
        .with_mime_type("text/html");
        let message = format!(
            "上传页面（5 分钟有效，首次成功后失效）：{}\n程序化上传：PUT {}\n链接本身即凭据，请勿转发。",
            structured["uploadPageUrl"]
                .as_str()
                .expect("上传地址应为字符串"),
            structured["putUrlTemplate"]
                .as_str()
                .expect("PUT 地址模板应为字符串")
        );
        audit.succeed();
        Ok(transfer_link_result(resource, message, structured))
    }

    #[tool(
        description = "将 MCP Roots 内的本地文件上传到远程路径",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn upload_local_file(
        &self,
        Parameters(args): Parameters<LocalTransferArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("upload_local_file", Some(&args.session_id));
        let local_path = rooted_path(&context, &args.local_path, true).await?;
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileWrite)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        let bytes = self
            .state
            .connection_manager
            .upload_file_quiet(&connection, &local_path, &args.remote_path)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"bytes": bytes})))
    }

    #[tool(
        description = "将远程文件下载到 MCP Roots 内的本地路径",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn download_remote_file(
        &self,
        Parameters(args): Parameters<LocalTransferArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("download_remote_file", Some(&args.session_id));
        let local_path = rooted_path(&context, &args.local_path, false).await?;
        let connection = self
            .authorized_connection(&args.session_id, Permission::FileRead)
            .await?;
        let _operation_lock = self.operation_lock(&args.session_id)?;
        let bytes = self
            .state
            .connection_manager
            .download_file_quiet(&connection, &args.remote_path, &local_path)
            .await
            .map_err(mcp_error)?;
        audit.succeed();
        Ok(json_result(&json!({"bytes": bytes})))
    }
}

impl McpService {
    fn settings(&self) -> Result<AppSettings, McpError> {
        current_mcp_settings(&self.state).map_err(mcp_error)
    }

    async fn authorized_connection(
        &self,
        session_id: &str,
        required: Permission,
    ) -> Result<String, McpError> {
        let session = authorized_session(&self.state, session_id, required)
            .await
            .map_err(mcp_access_error)?;
        let mut cache = self.connections.lock().await;
        if let Some(existing) = cache.get_mut(session_id) {
            if existing.last_used.elapsed() < CONNECTION_IDLE {
                existing.last_used = Instant::now();
                return Ok(existing.connection_id.clone());
            }
            let expired = existing.connection_id.clone();
            cache.remove(session_id);
            drop(cache);
            let _ = self.state.connection_manager.disconnect(&expired).await;
            cache = self.connections.lock().await;
        }
        let connection = self
            .state
            .connection_manager
            .connect_headless(session, &self.state.credential_service)
            .await
            .map_err(mcp_error)?;
        cache.insert(
            session_id.to_owned(),
            CachedConnection {
                connection_id: connection.connection_id.clone(),
                last_used: Instant::now(),
            },
        );
        let cached_connections = self.connections.clone();
        let connection_manager = self.state.connection_manager.clone();
        let session_id = session_id.to_owned();
        let connection_id = connection.connection_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(CONNECTION_IDLE).await;
            let expired = {
                let mut cache = cached_connections.lock().await;
                let should_remove = cache.get(&session_id).is_some_and(|entry| {
                    entry.connection_id == connection_id
                        && entry.last_used.elapsed() >= CONNECTION_IDLE
                });
                should_remove.then(|| cache.remove(&session_id)).flatten()
            };
            if let Some(expired) = expired {
                let _ = connection_manager.disconnect(&expired.connection_id).await;
            }
        });
        Ok(connection.connection_id)
    }
}

fn current_mcp_settings(state: &AppState) -> Result<AppSettings, AppError> {
    let mut settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    settings.reload_mcp_runtime_settings()?;
    Ok(settings.get())
}

#[derive(Clone, Copy)]
pub(crate) enum Permission {
    SessionRead,
    FileRead,
    Command,
    FileWrite,
    FileDelete,
}

impl Permission {
    fn allowed(self, permission: &McpGroupPermission) -> bool {
        match self {
            Self::SessionRead => permission.session_read,
            Self::FileRead => permission.file_read,
            Self::Command => permission.command_execute,
            Self::FileWrite => permission.file_write,
            Self::FileDelete => permission.file_delete,
        }
    }
}

#[derive(Debug)]
pub(crate) enum McpAccessError {
    NotFound(String),
    Forbidden(String),
    Internal(String),
}

impl Display for McpAccessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(message) | Self::Forbidden(message) | Self::Internal(message) => {
                formatter.write_str(message)
            }
        }
    }
}

pub(crate) async fn authorized_session(
    state: &AppState,
    session_id: &str,
    required: Permission,
) -> Result<StoredSession, McpAccessError> {
    let settings =
        current_mcp_settings(state).map_err(|error| McpAccessError::Internal(error.to_string()))?;
    if !settings.mcp_enabled {
        return Err(McpAccessError::Forbidden(localized_access_error(
            &settings.language,
            AccessIssue::ServiceDisabled,
        )));
    }
    let session = state
        .session_service
        .lock()
        .await
        .find(session_id)
        .map_err(|error| match error {
            AppError::NotFound(message) => McpAccessError::NotFound(message),
            error => McpAccessError::Internal(error.to_string()),
        })?;
    let access = permission(&settings.mcp_group_permissions, &session.group).ok_or_else(|| {
        McpAccessError::Forbidden(localized_access_error(
            &settings.language,
            AccessIssue::GroupDisabled,
        ))
    })?;
    if !required.allowed(access) {
        return Err(McpAccessError::Forbidden(localized_access_error(
            &settings.language,
            AccessIssue::PermissionDenied,
        )));
    }
    Ok(session)
}

fn permission<'a>(
    permissions: &'a [McpGroupPermission],
    group: &str,
) -> Option<&'a McpGroupPermission> {
    permissions
        .iter()
        .find(|permission| permission.group_name == group && permission.enabled)
}

fn json_result(value: &impl Serialize) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned()),
    )])
}

fn structured_json_result(value: &impl Serialize) -> CallToolResult {
    let structured_content = serde_json::to_value(value).unwrap_or_else(|_| json!({}));
    let mut result = json_result(value);
    result.structured_content = Some(structured_content);
    result
}

#[derive(Clone, Copy)]
enum AccessIssue {
    ServiceDisabled,
    GroupDisabled,
    PermissionDenied,
}

fn localized_access_error(language: &Language, issue: AccessIssue) -> String {
    let message = match (language, issue) {
        (Language::ZhCn, AccessIssue::ServiceDisabled) => "MCP 服务未启用。",
        (Language::ZhCn, AccessIssue::GroupDisabled) => "当前分组未授权。",
        (Language::ZhCn, AccessIssue::PermissionDenied) => "当前工具未获得分组权限。",
        (Language::EnUs, AccessIssue::ServiceDisabled) => "The MCP service is disabled.",
        (Language::EnUs, AccessIssue::GroupDisabled) => {
            "The current session group is not authorized."
        }
        (Language::EnUs, AccessIssue::PermissionDenied) => {
            "The current tool is not authorized for this session group."
        }
    };
    let hint = if matches!(language, Language::EnUs) {
        "Call get_permission_guide with the current tool name for setup instructions."
    } else {
        "请使用当前工具名调用 get_permission_guide 获取设置步骤。"
    };
    if matches!(language, Language::EnUs) {
        format!("{message} {hint}")
    } else {
        format!("{message}{hint}")
    }
}

fn transfer_link_result(
    resource: Resource,
    message: String,
    structured_content: serde_json::Value,
) -> CallToolResult {
    let mut result = CallToolResult::success(vec![
        ContentBlock::resource_link(resource),
        ContentBlock::text(message),
    ]);
    result.structured_content = Some(structured_content);
    result
}

fn remote_file_name(remote_path: &str) -> Result<String, McpError> {
    remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| McpError::invalid_params("远程文件路径无效", None))
}

fn tool_error(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.to_owned())])
}

fn mcp_error(error: AppError) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

fn mcp_access_error(error: McpAccessError) -> McpError {
    match error {
        McpAccessError::Internal(message) => McpError::internal_error(message, None),
        McpAccessError::NotFound(message) | McpAccessError::Forbidden(message) => {
            McpError::invalid_request(message, None)
        }
    }
}

// 当前稳定客户端仍通过 Roots 声明本地边界；SDK 的替代能力尚未进入兼容规范。
#[allow(deprecated)]
async fn rooted_path(
    context: &RequestContext<RoleServer>,
    path: &str,
    must_exist: bool,
) -> Result<std::path::PathBuf, McpError> {
    let requested = std::path::PathBuf::from(path);
    if !requested.is_absolute() {
        return Err(McpError::invalid_params("本地路径必须是绝对路径", None));
    }
    let roots = context
        .peer
        .list_roots()
        .await
        .map_err(|_| McpError::invalid_request("客户端未提供 Roots", None))?;
    for root in roots.roots {
        let Ok(url) = url::Url::parse(&root.uri) else {
            continue;
        };
        let Ok(root_path) = url.to_file_path() else {
            continue;
        };
        let Ok(root_path) = std::fs::canonicalize(root_path) else {
            continue;
        };
        let candidate = if must_exist {
            std::fs::canonicalize(&requested).ok()
        } else {
            requested
                .parent()
                .and_then(|parent| std::fs::canonicalize(parent).ok())
                .and_then(|parent| requested.file_name().map(|name| parent.join(name)))
        };
        if candidate
            .as_ref()
            .is_some_and(|candidate| candidate.starts_with(&root_path))
        {
            return Ok(candidate.expect("已检查本地路径"));
        }
    }
    Err(McpError::invalid_request("本地路径不在 MCP Roots 内", None))
}

#[tool_handler]
impl ServerHandler for McpService {
    fn get_info(&self) -> ServerInfo {
        let language = self
            .settings()
            .map(|settings| settings.language)
            .unwrap_or(Language::ZhCn);
        let english = matches!(language, Language::EnUs);
        let transfer_note = if self.transport == "http" && english {
            "HTTP file transfer tools return five-minute links that act as credentials."
        } else if self.transport == "http" {
            "HTTP 文件传输工具返回 5 分钟有效链接；链接本身即凭据。"
        } else if english {
            "stdio local file transfers can only access Roots declared by the client."
        } else {
            "stdio 本地文件传输仅可访问客户端声明的 MCP Roots。"
        };
        let instructions = if english {
            format!(
                "Only operate session groups authorized in FsTTY Settings. Saved group permissions apply to new requests immediately. Credentials are never returned or modified. Call get_permission_guide when authorization is missing. {transfer_note}"
            )
        } else {
            format!(
                "仅操作设置页已授权的会话分组；分组权限保存后对新请求立即生效；不会返回或修改凭据。权限不足时调用 get_permission_guide 获取设置步骤。{transfer_note}"
            )
        };
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(instructions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::SettingsService;

    fn mcp_permission(command_execute: bool) -> McpGroupPermission {
        McpGroupPermission {
            group_name: "生产".to_owned(),
            enabled: true,
            session_read: true,
            file_read: true,
            command_execute,
            file_write: false,
            file_delete: false,
        }
    }

    fn write_test_session(directory: &std::path::Path, session_id: &str) {
        let store = json!({
            "version": 1,
            "sessions": [{
                "id": session_id,
                "name": "测试会话",
                "host": "127.0.0.1",
                "port": 22,
                "username": "ubuntu",
                "group": "生产",
                "tags": [],
                "auth": {
                    "kind": "password"
                },
                "loginSavePrompted": false
            }],
            "pendingCredentialCleanupIds": []
        });
        std::fs::write(
            directory.join("sessions.v1.json"),
            serde_json::to_vec_pretty(&store).expect("无法序列化测试会话"),
        )
        .expect("无法写入测试会话");
    }

    #[tokio::test]
    async fn http_listener_binds_all_ipv4_interfaces() {
        let listener = tokio::net::TcpListener::bind(http_bind_address(0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();

        assert_eq!(
            address.ip(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
        );
        assert_ne!(address.port(), 0);
    }

    #[test]
    fn http_server_accepts_remote_host_headers() {
        let config = http_server_config(CancellationToken::new());

        assert!(config.allowed_hosts.is_empty());
    }

    #[test]
    fn http_headers_accept_valid_native_client() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());

        assert_eq!(validate_http_headers(&headers, "secret"), Ok(()));
    }

    #[test]
    fn http_headers_reject_missing_or_invalid_token() {
        assert_eq!(
            validate_http_headers(&HeaderMap::new(), "secret"),
            Err(StatusCode::UNAUTHORIZED)
        );

        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer invalid".parse().unwrap());
        assert_eq!(
            validate_http_headers(&headers, "secret"),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn http_headers_reject_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        headers.insert(header::ORIGIN, "https://example.com".parse().unwrap());

        assert_eq!(
            validate_http_headers(&headers, "secret"),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn 大文件条件读取支持忽略大小写和上下文() {
        let content = b"before\nERROR first\nafter\nnormal\nerror second\ntail\n";
        let result = search_remote_text(RemoteFileSearchInput {
            content,
            start_offset: 0,
            file_size: content.len() as u64,
            starts_at_line_boundary: true,
            window_reaches_end: true,
            query: "error",
            case_sensitive: false,
            before_lines: 1,
            after_lines: 1,
            max_matches: 50,
        });

        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].before, vec!["before"]);
        assert_eq!(result.matches[0].after, vec!["after"]);
        assert_eq!(result.matches[1].line, "error second");
        assert_eq!(result.matches[1].before, vec!["normal"]);
        assert_eq!(result.matches[1].after, vec!["tail"]);
        assert!(result.end_of_file);
        assert!(!result.output_truncated);
    }

    #[test]
    fn 大文件条件读取跳过窗口起始残行并限制匹配数量() {
        let content = b"partial ERROR\nok\nERROR first\nERROR second\n";
        let result = search_remote_text(RemoteFileSearchInput {
            content,
            start_offset: 1_000,
            file_size: 1_000 + content.len() as u64,
            starts_at_line_boundary: false,
            window_reaches_end: true,
            query: "ERROR",
            case_sensitive: true,
            before_lines: 0,
            after_lines: 0,
            max_matches: 1,
        });

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line, "ERROR first");
        assert_eq!(result.matches[0].byte_offset, 1_017);
        assert!(result.match_limit_reached);
        assert!(!result.end_of_file);
    }

    #[test]
    fn 大文件条件读取对非_utf8_日志使用有损解码() {
        let content = b"ok\nerror \xff\n";
        let result = search_remote_text(RemoteFileSearchInput {
            content,
            start_offset: 0,
            file_size: content.len() as u64,
            starts_at_line_boundary: true,
            window_reaches_end: true,
            query: "error",
            case_sensitive: true,
            before_lines: 0,
            after_lines: 0,
            max_matches: 50,
        });

        assert_eq!(result.matches.len(), 1);
        assert!(result.lossy_decoding);
    }

    #[test]
    fn 大文件条件读取截断中文长行且保留_json_转义字符() {
        let content = format!("匹配\"\\{}\n", "长".repeat(3_000));
        let result = search_remote_text(RemoteFileSearchInput {
            content: content.as_bytes(),
            start_offset: 0,
            file_size: content.len() as u64,
            starts_at_line_boundary: true,
            window_reaches_end: true,
            query: "匹配",
            case_sensitive: true,
            before_lines: 0,
            after_lines: 0,
            max_matches: 50,
        });

        assert_eq!(result.matches[0].line.chars().count(), 2_048);
        assert!(result.matches[0].line.starts_with("匹配\"\\"));
        assert!(result.matches[0].line_truncated);
    }

    #[test]
    fn 大文件条件读取支持前后各五十行上下文() {
        let before = (0..50)
            .map(|index| format!("before-{index}"))
            .collect::<Vec<_>>();
        let after = (0..50)
            .map(|index| format!("after-{index}"))
            .collect::<Vec<_>>();
        let content = format!("{}\nMATCH\n{}\n", before.join("\n"), after.join("\n"));
        let result = search_remote_text(RemoteFileSearchInput {
            content: content.as_bytes(),
            start_offset: 0,
            file_size: content.len() as u64,
            starts_at_line_boundary: true,
            window_reaches_end: true,
            query: "MATCH",
            case_sensitive: true,
            before_lines: 50,
            after_lines: 50,
            max_matches: 50,
        });

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].before, before);
        assert_eq!(result.matches[0].after, after);
    }

    #[test]
    fn 大文件条件读取拒绝超过五十行上下文() {
        let args = SearchRemoteFileArgs {
            session_id: "session".to_owned(),
            path: "/var/log/app.log".to_owned(),
            query: "ERROR".to_owned(),
            offset: 0,
            tail: false,
            scan_bytes: default_search_scan_bytes(),
            case_sensitive: false,
            before_lines: 50,
            after_lines: 50,
            max_matches: 50,
        };
        assert!(validate_search_remote_file_args(&args).is_ok());

        let invalid_before = SearchRemoteFileArgs {
            before_lines: 51,
            ..args
        };
        assert_eq!(
            validate_search_remote_file_args(&invalid_before),
            Err("beforeLines 和 afterLines 必须在 0 到 50 之间")
        );
    }

    #[test]
    fn 大文件条件读取_schema_声明明确范围() {
        let schema = serde_json::to_value(schemars::schema_for!(SearchRemoteFileArgs))
            .expect("搜索参数 Schema 应可序列化");

        assert_eq!(schema["properties"]["beforeLines"]["minimum"], 0);
        assert_eq!(schema["properties"]["beforeLines"]["maximum"], 50);
        assert_eq!(schema["properties"]["afterLines"]["minimum"], 0);
        assert_eq!(schema["properties"]["afterLines"]["maximum"], 50);
        assert_eq!(schema["properties"]["maxMatches"]["minimum"], 1);
        assert_eq!(schema["properties"]["maxMatches"]["maximum"], 50);
        assert_eq!(
            schema["properties"]["scanBytes"]["maximum"],
            16 * 1024 * 1024
        );
    }

    #[test]
    fn 大文件条件读取响应严格限制为八_mib() {
        let escaped_line = format!("中文\"{}", "\\".repeat(2_044));
        let matches = (0..12)
            .map(|index| RemoteFileSearchMatch {
                byte_offset: index * 10_000,
                line: escaped_line.clone(),
                before: vec![escaped_line.clone(); 50],
                after: vec![escaped_line.clone(); 50],
                line_truncated: false,
            })
            .collect();
        let response = search_json_result(RemoteFileSearchResult {
            matches,
            start_offset: 0,
            next_offset: 120_000,
            file_size: 120_000,
            scanned_bytes: 120_000,
            end_of_file: true,
            match_limit_reached: false,
            lossy_decoding: false,
            output_truncated: false,
        });
        let encoded = serde_json::to_vec(&response).expect("MCP 响应应可序列化");
        let response_value = serde_json::to_value(response).expect("MCP 响应应可转换为 JSON");
        let result_text = response_value["content"][0]["text"]
            .as_str()
            .expect("MCP 响应应包含文本结果");
        let result: serde_json::Value =
            serde_json::from_str(result_text).expect("搜索结果应为 JSON");

        assert!(encoded.len() <= MAX_SEARCH_RESPONSE_BYTES);
        assert_eq!(result["outputTruncated"], true);
        assert_eq!(result["endOfFile"], false);
        assert!(result["nextOffset"]
            .as_u64()
            .is_some_and(|offset| offset < 120_000));
    }

    #[test]
    fn 未授权分组不会获得任何权限() {
        let permissions = vec![McpGroupPermission {
            group_name: "生产".to_owned(),
            enabled: false,
            session_read: true,
            file_read: true,
            command_execute: true,
            file_write: true,
            file_delete: true,
        }];
        assert!(permission(&permissions, "生产").is_none());
        assert!(permission(&permissions, "未知").is_none());
    }

    #[test]
    fn 权限引导按语言返回权限名称和步骤() {
        let chinese =
            permission_guide_response(&Language::ZhCn, Some("execute_command".to_owned()))
                .expect("中文权限引导应生成成功");
        assert_eq!(chinese.locale, "zh-CN");
        assert_eq!(chinese.permission_key, Some("commandExecute"));
        assert_eq!(chinese.permission_name, Some("命令执行"));
        assert!(chinese
            .steps
            .iter()
            .any(|step| step.contains("保存 MCP 设置")));
        assert!(chinese
            .warning
            .is_some_and(|warning| warning.contains("高风险")));

        let english =
            permission_guide_response(&Language::EnUs, Some("read_remote_file".to_owned()))
                .expect("英文权限引导应生成成功");
        assert_eq!(english.locale, "en-US");
        assert_eq!(english.permission_key, Some("fileRead"));
        assert_eq!(english.permission_name, Some("Remote file read"));
        assert!(english
            .steps
            .iter()
            .any(|step| step.contains("Save MCP settings")));
    }

    #[test]
    fn 完整权限矩阵不包含会话或分组信息() {
        let guide =
            permission_guide_response(&Language::ZhCn, None).expect("完整权限引导应生成成功");
        let value = serde_json::to_value(guide).expect("权限引导应能序列化");
        let text = value.to_string();

        assert_eq!(
            value["permissions"]
                .as_array()
                .expect("应返回权限矩阵")
                .len(),
            GUIDE_PERMISSIONS.len()
        );
        assert!(!text.contains("sessionId"));
        assert!(!text.contains("groupName"));
        assert!(!text.contains("host"));
        assert!(!text.contains("username"));
    }

    #[test]
    fn agent提示词覆盖工具使用指南() {
        let prompt = mcp_agent_prompt();

        for tool in supported_guide_tools() {
            assert!(prompt.contains(tool), "提示词缺少工具：{tool}");
        }
        assert!(prompt.starts_with("<!-- fstty:begin -->\n\n"));
        assert!(prompt.ends_with("\n\n<!-- fstty:end -->"));
        assert_eq!(prompt.matches("<!-- fstty:begin -->").count(), 1);
        assert_eq!(prompt.matches("<!-- fstty:end -->").count(), 1);
        assert!(prompt.contains("get_permission_guide"));
        assert!(prompt.contains("Call list_sessions first"));
        assert!(prompt.contains("discover available sessions"));
        assert!(prompt.contains("execute_command runs remote shell commands"));
        assert!(prompt.contains("commandExecute permission"));
        assert!(prompt.contains("MCP client Roots"));
        assert!(prompt.contains("links expire after five minutes"));
        assert!(prompt.contains("Host-key and credential issues are handled in FsTTY"));
        assert!(prompt.contains("live MCP tool schemas"));
        assert!(prompt.contains("Permission and tool mapping"));
        assert!(!prompt.contains("use only returned sessions"));
        assert!(!prompt.contains("only when needed and authorized"));
        assert!(!prompt.contains("do not use it to bypass"));
        assert!(!prompt.contains("wait for user authorization"));
        assert!(!prompt.contains("Confirm the exact target"));
        assert!(!prompt.contains("rollback considerations"));
        assert!(!prompt.contains("untrusted data"));
        assert!(!prompt.contains("Never request, expose, log, or persist"));
        assert!(prompt.is_ascii());
        assert!(prompt.len() <= 2_048);
        assert!(!prompt.contains("Bearer "));
        assert!(!prompt.contains("<FSTTY_HOST_IP>"));
    }

    #[test]
    fn 每个操作工具只映射一个权限且未知工具返回本地化错误() {
        let tools = supported_guide_tools();
        let mut unique = tools.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(tools.len(), unique.len());
        assert!(tools
            .iter()
            .all(|tool| guide_permission_for_tool(tool).is_some()));

        let chinese = permission_guide_response(&Language::ZhCn, Some("unknown_tool".to_owned()))
            .expect_err("未知工具应失败");
        assert!(chinese.starts_with("未知工具"));
        let english = permission_guide_response(&Language::EnUs, Some("unknown_tool".to_owned()))
            .expect_err("未知工具应失败");
        assert!(english.starts_with("Unknown tool"));
    }

    #[test]
    fn 权限错误包含本地化引导提示() {
        let chinese = localized_access_error(&Language::ZhCn, AccessIssue::PermissionDenied);
        assert!(chinese.contains("get_permission_guide"));
        assert!(chinese.contains("当前工具未获得分组权限"));

        let english = localized_access_error(&Language::EnUs, AccessIssue::PermissionDenied);
        assert!(english.contains("get_permission_guide"));
        assert!(english.contains("not authorized"));
    }

    #[test]
    fn 同一服务实例可热加载当前设置语言() {
        let directory =
            std::env::temp_dir().join(format!("fstty-mcp-guide-language-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("无法创建测试目录");
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, false, 37_653, Vec::new())
            .expect("保存 MCP 设置失败");
        let state = AppState::new(directory.clone());
        let service = McpService::new(state, "stdio");

        assert_eq!(
            service.settings().expect("读取中文设置失败").language,
            Language::ZhCn
        );
        writer.set_language(Language::EnUs).expect("切换英文失败");
        assert_eq!(
            service.settings().expect("热加载英文失败").language,
            Language::EnUs
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn stdio和http相同服务实例热加载命令权限() {
        let directory =
            std::env::temp_dir().join(format!("fstty-mcp-hot-reload-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("无法创建测试目录");
        let session_id = Uuid::new_v4().to_string();
        write_test_session(&directory, &session_id);
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(false)])
            .expect("保存初始权限失败");

        let state = AppState::new(directory.clone());
        let stdio = McpService::new(state.clone(), "stdio");
        let transfers = McpTransferRuntime::new(state.clone(), 37_653, CancellationToken::new());
        let http = McpService::new_http(state, transfers);

        assert!(matches!(
            authorized_session(&stdio.state, &session_id, Permission::Command).await,
            Err(McpAccessError::Forbidden(_))
        ));
        assert!(matches!(
            authorized_session(&http.state, &session_id, Permission::Command).await,
            Err(McpAccessError::Forbidden(_))
        ));

        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(true)])
            .expect("授予命令权限失败");
        assert!(
            authorized_session(&stdio.state, &session_id, Permission::Command)
                .await
                .is_ok()
        );
        assert!(
            authorized_session(&http.state, &session_id, Permission::Command)
                .await
                .is_ok()
        );

        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(false)])
            .expect("撤销命令权限失败");
        assert!(matches!(
            authorized_session(&stdio.state, &session_id, Permission::Command).await,
            Err(McpAccessError::Forbidden(_))
        ));
        assert!(matches!(
            authorized_session(&http.state, &session_id, Permission::Command).await,
            Err(McpAccessError::Forbidden(_))
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn 传输链接同时返回标准资源和结构化数据() {
        let structured = json!({
            "downloadUrl": "http://127.0.0.1:37653/downloads/ticket",
            "expiresInSeconds": 300,
        });
        let result = transfer_link_result(
            Resource::new("http://127.0.0.1:37653/downloads/ticket", "report.txt")
                .with_mime_type("application/octet-stream")
                .with_size(42),
            "下载链接".to_owned(),
            structured.clone(),
        );

        assert_eq!(result.structured_content, Some(structured));
        assert!(result.content[0].as_resource_link().is_some());
        assert_eq!(
            result.content[0]
                .as_resource_link()
                .expect("首个内容块应为资源链接")
                .size,
            Some(42)
        );
        assert_eq!(
            result.content[1]
                .as_text()
                .expect("第二个内容块应为文本")
                .text,
            "下载链接"
        );
    }

    #[tokio::test]
    async fn 运行时令牌可原地更新且不会停止监听() {
        let runtime = McpHttpRuntime::default();
        let cancellation = CancellationToken::new();
        let bearer_token = Arc::new(RwLock::new(Zeroizing::new("旧令牌".to_owned())));
        let directory = std::env::temp_dir().join(format!("fstty-mcp-runtime-{}", Uuid::new_v4()));
        let transfer_runtime = McpTransferRuntime::new(
            AppState::new(directory.clone()),
            37_653,
            cancellation.child_token(),
        );
        transfer_runtime
            .issue_download(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp/report.txt".to_owned(),
                "report.txt".to_owned(),
            )
            .await
            .unwrap();
        runtime.state.lock().await.running = Some(RunningMcpHttp {
            port: 37_653,
            cancellation: cancellation.clone(),
            bearer_token: bearer_token.clone(),
            transfer_runtime: transfer_runtime.clone(),
        });

        assert_eq!(runtime.running_port().await, Some(37_653));
        assert!(runtime.update_token("旧令牌".to_owned()).await);
        assert_eq!(transfer_runtime.ticket_count().await, 1);
        assert!(runtime.update_token("新令牌".to_owned()).await);
        assert_eq!(bearer_token.read().await.as_str(), "新令牌");
        assert_eq!(transfer_runtime.ticket_count().await, 0);
        assert!(!cancellation.is_cancelled());

        runtime.stop().await;
        assert!(cancellation.is_cancelled());
        assert_eq!(runtime.running_port().await, None);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn 不同传输只暴露适用的文件传输工具() {
        let directory = std::env::temp_dir().join(format!("fstty-mcp-tools-{}", Uuid::new_v4()));
        let state = AppState::new(directory.clone());
        let stdio = McpService::new(state.clone(), "stdio");
        assert!(stdio.tool_router.has_route("get_permission_guide"));
        assert!(stdio.tool_router.has_route("search_remote_file"));
        assert!(stdio.tool_router.has_route("upload_local_file"));
        assert!(stdio.tool_router.has_route("download_remote_file"));
        assert!(!stdio
            .tool_router
            .has_route("create_remote_file_download_link"));
        assert!(!stdio
            .tool_router
            .has_route("create_remote_file_upload_link"));

        let cancellation = CancellationToken::new();
        let transfers = McpTransferRuntime::new(state.clone(), 37_653, cancellation);
        let http = McpService::new_http(state, transfers);
        assert!(http.tool_router.has_route("get_permission_guide"));
        assert!(http.tool_router.has_route("search_remote_file"));
        assert!(!http.tool_router.has_route("upload_local_file"));
        assert!(!http.tool_router.has_route("download_remote_file"));
        assert!(http
            .tool_router
            .has_route("create_remote_file_download_link"));
        assert!(http.tool_router.has_route("create_remote_file_upload_link"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
