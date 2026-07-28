use crate::mcp_transfer::{http_base_url, McpTransferRuntime};
use crate::models::{AppError, McpGroupPermission, StoredSession};
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
    collections::HashMap,
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

fn default_timeout() -> u64 {
    60
}

fn default_read_limit() -> usize {
    1024 * 1024
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
    fn settings(&self) -> Result<crate::models::AppSettings, McpError> {
        self.state
            .settings_service
            .lock()
            .map(|settings| settings.get())
            .map_err(|_| McpError::internal_error("设置服务锁定失败", None))
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
    let settings = state
        .settings_service
        .lock()
        .map_err(|_| McpAccessError::Internal("设置服务锁定失败".to_owned()))?
        .get();
    if !settings.mcp_enabled {
        return Err(McpAccessError::Forbidden("MCP 服务未启用".to_owned()));
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
    let access = permission(&settings.mcp_group_permissions, &session.group)
        .ok_or_else(|| McpAccessError::Forbidden("当前分组未授权".to_owned()))?;
    if !required.allowed(access) {
        return Err(McpAccessError::Forbidden(
            "当前工具未获得分组权限".to_owned(),
        ));
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
        let transfer_note = if self.transport == "http" {
            "HTTP 文件传输工具返回 5 分钟有效链接；链接本身即凭据。"
        } else {
            "stdio 本地文件传输仅可访问客户端声明的 MCP Roots。"
        };
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(format!(
                "仅操作设置页已授权的会话分组；不会返回或修改凭据。{transfer_note}"
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!http.tool_router.has_route("upload_local_file"));
        assert!(!http.tool_router.has_route("download_remote_file"));
        assert!(http
            .tool_router
            .has_route("create_remote_file_download_link"));
        assert!(http.tool_router.has_route("create_remote_file_upload_link"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
