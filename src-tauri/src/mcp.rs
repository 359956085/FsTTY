use crate::mcp_transfer::{http_base_url, McpTransferRuntime};
use crate::models::{AppError, AppSettings, Language, McpGroupPermission, StoredSession};
use crate::services::AppState;
#[cfg(test)]
use axum::http::{header, HeaderMap, StatusCode};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rmcp::schemars;
use rmcp::{
    handler::server::{router::tool::ToolRouter, tool::Extension, wrapper::Parameters},
    model::*,
    service::RequestContext,
    tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fmt::{Display, Formatter},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
#[cfg(test)]
use tokio::sync::RwLock;
#[cfg(test)]
use tokio_util::sync::CancellationToken;
#[cfg(test)]
use uuid::Uuid;
#[cfg(test)]
use zeroize::Zeroizing;

const CONNECTION_IDLE: Duration = Duration::from_secs(300);
const MAX_COMMAND_BYTES: usize = 64 * 1024;
mod audit;
mod catalog;
mod http;
mod result;
mod search;

use audit::{write_file_audit_input, AuditGuard};
use catalog::permission_guide_response;
#[cfg(test)]
use catalog::{guide_permission_for_tool, supported_guide_tools, GUIDE_PERMISSIONS};
pub(crate) use catalog::{mcp_agent_prompt, permission_catalog, McpPermissionCatalogEntry};
pub use http::{get_or_create_http_token, rotate_http_token, McpHttpRuntime};
#[cfg(test)]
use http::{http_bind_address, http_server_config, validate_http_headers, RunningMcpHttp};
use result::{
    json_result, remote_file_name, structured_json_result, tool_error, transfer_link_result,
};
#[cfg(test)]
use search::{
    default_search_scan_bytes, RemoteFileSearchMatch, RemoteFileSearchResult,
    MAX_SEARCH_RESPONSE_BYTES,
};
use search::{
    search_json_result, search_remote_text, validate_search_remote_file_args,
    RemoteFileSearchInput, SearchRemoteFileArgs,
};

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

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SessionArgs {
    session_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListFilesArgs {
    session_id: String,
    path: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadFileArgs {
    session_id: String,
    path: String,
    #[serde(default)]
    offset: u64,
    #[serde(default = "default_read_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CommandArgs {
    session_id: String,
    command: String,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WriteFileArgs {
    session_id: String,
    path: String,
    content: String,
    #[serde(default)]
    base64: bool,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateDirectoryArgs {
    session_id: String,
    parent_path: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenameArgs {
    session_id: String,
    path: String,
    new_name: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    session_id: String,
    source_path: String,
    target_directory: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DeleteArgs {
    session_id: String,
    path: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LocalTransferArgs {
    session_id: String,
    local_path: String,
    remote_path: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DownloadLinkArgs {
    session_id: String,
    remote_path: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UploadLinkArgs {
    session_id: String,
    remote_directory: String,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
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

    fn audit<T: Serialize>(
        &self,
        tool: &'static str,
        session_id: Option<&str>,
        input: &T,
    ) -> AuditGuard {
        let input = current_mcp_settings(&self.state)
            .ok()
            .filter(|settings| settings.record_mcp_tool_inputs)
            .and_then(|_| serde_json::to_value(input).ok());
        self.audit_guard(tool, session_id, input)
    }

    fn audit_write_file(&self, args: &WriteFileArgs) -> AuditGuard {
        // 开关关闭时不计算正文摘要，避免默认路径承担大文件哈希开销。
        let input = current_mcp_settings(&self.state)
            .ok()
            .filter(|settings| settings.record_mcp_tool_inputs)
            .map(|_| {
                write_file_audit_input(&args.session_id, &args.path, &args.content, args.base64)
            });
        self.audit_guard("write_remote_file", Some(&args.session_id), input)
    }

    fn audit_guard(
        &self,
        tool: &'static str,
        session_id: Option<&str>,
        input: Option<Value>,
    ) -> AuditGuard {
        AuditGuard::new(
            self.state.mcp_audit_service.clone(),
            self.transport,
            tool,
            session_id.map(ToOwned::to_owned),
            input,
        )
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
        let audit = self.audit("get_permission_guide", None, &args);
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
        let audit = self.audit("list_sessions", None, &json!({}));
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
        let permissions = self
            .state
            .mcp_command_policy_service
            .lock()
            .map_err(|_| McpError::internal_error("MCP 策略服务锁定失败", None))?
            .list_permissions()
            .map_err(mcp_error)?;
        let sessions = groups
            .into_iter()
            .filter(|group| {
                permission(&permissions, &group.name)
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
        let audit = self.audit("get_device_status", Some(&args.session_id), &args);
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
        let audit = self.audit("list_remote_files", Some(&args.session_id), &args);
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
        let audit = self.audit("read_remote_file", Some(&args.session_id), &args);
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
        let audit = self.audit("search_remote_file", Some(&args.session_id), &args);
        validate_search_remote_file_args(&args)
            .map_err(|message| McpError::invalid_params(message, None))?;
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
        description = "查询会话当前生效的命令规则和 Shell 语法限制；不连接 SSH",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn get_command_policy(
        &self,
        Parameters(args): Parameters<SessionArgs>,
    ) -> Result<CallToolResult, McpError> {
        let audit = self.audit("get_command_policy", Some(&args.session_id), &args);
        let (_, access, _) =
            authorized_session_context(&self.state, &args.session_id, Permission::Command)
                .await
                .map_err(mcp_access_error)?;
        let response = command_policy_response(&args.session_id, &access);
        audit.succeed();
        Ok(structured_json_result(&response))
    }

    #[tool(
        description = "执行非交互式远程 Shell 命令；执行前调用 get_command_policy 查询限制",
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
        let audit = self.audit("execute_command", Some(&args.session_id), &args);
        if args.command.trim().is_empty() || args.command.len() > MAX_COMMAND_BYTES {
            return Ok(tool_error("命令为空或过长"));
        }
        let connection = self
            .authorized_command_connection(&args.session_id, &args.command)
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
        let audit = self.audit_write_file(&args);
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
        let audit = self.audit("create_remote_directory", Some(&args.session_id), &args);
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
        let audit = self.audit("rename_remote_entry", Some(&args.session_id), &args);
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
        let audit = self.audit("move_remote_entry", Some(&args.session_id), &args);
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
        let audit = self.audit("delete_remote_entry", Some(&args.session_id), &args);
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
        let audit = self.audit(
            "create_remote_file_download_link",
            Some(&args.session_id),
            &args,
        );
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
        let audit = self.audit(
            "create_remote_file_upload_link",
            Some(&args.session_id),
            &args,
        );
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
        let audit = self.audit("upload_local_file", Some(&args.session_id), &args);
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
        let audit = self.audit("download_remote_file", Some(&args.session_id), &args);
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
        self.connection_for_session(session_id, session).await
    }

    async fn authorized_command_connection(
        &self,
        session_id: &str,
        command: &str,
    ) -> Result<String, McpError> {
        let session = authorized_command_session(&self.state, session_id, command)
            .await
            .map_err(mcp_access_error)?;
        self.connection_for_session(session_id, session).await
    }

    async fn connection_for_session(
        &self,
        session_id: &str,
        session: StoredSession,
    ) -> Result<String, McpError> {
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
    UnsupportedSyntax {
        message: String,
        kind: crate::mcp_command_policy::UnsupportedShellSyntaxKind,
    },
}

impl Display for McpAccessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(message) | Self::Forbidden(message) | Self::Internal(message) => {
                formatter.write_str(message)
            }
            Self::UnsupportedSyntax { message, .. } => formatter.write_str(message),
        }
    }
}

pub(crate) async fn authorized_session(
    state: &AppState,
    session_id: &str,
    required: Permission,
) -> Result<StoredSession, McpAccessError> {
    authorized_session_context(state, session_id, required)
        .await
        .map(|(session, _, _)| session)
}

async fn authorized_command_session(
    state: &AppState,
    session_id: &str,
    command: &str,
) -> Result<StoredSession, McpAccessError> {
    let (session, access, language) =
        authorized_session_context(state, session_id, Permission::Command).await?;
    match crate::mcp_command_policy::evaluate_command_policy(&access.command_policy, command) {
        crate::mcp_command_policy::CommandPolicyDecision::Allowed => {}
        crate::mcp_command_policy::CommandPolicyDecision::Denied => {
            return Err(McpAccessError::Forbidden(localized_access_error(
                &language,
                AccessIssue::CommandPolicyDenied,
            )));
        }
        crate::mcp_command_policy::CommandPolicyDecision::UnsupportedSyntax(kind) => {
            return Err(McpAccessError::UnsupportedSyntax {
                message: localized_unsupported_syntax_error(&language, kind),
                kind,
            });
        }
    }
    Ok(session)
}

async fn authorized_session_context(
    state: &AppState,
    session_id: &str,
    required: Permission,
) -> Result<(StoredSession, McpGroupPermission, Language), McpAccessError> {
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
    let access = state
        .mcp_command_policy_service
        .lock()
        .map_err(|_| McpAccessError::Internal("MCP 策略服务锁定失败".to_owned()))?
        .permission(&session.group)
        .map_err(|error| McpAccessError::Internal(error.to_string()))?
        .filter(|permission| permission.enabled)
        .ok_or_else(|| {
            McpAccessError::Forbidden(localized_access_error(
                &settings.language,
                AccessIssue::GroupDisabled,
            ))
        })?;
    if !required.allowed(&access) {
        return Err(McpAccessError::Forbidden(localized_access_error(
            &settings.language,
            AccessIssue::PermissionDenied,
        )));
    }
    Ok((session, access, settings.language))
}

fn command_policy_response(session_id: &str, access: &McpGroupPermission) -> Value {
    let policy = &access.command_policy;
    let empty_rules: &[crate::models::McpCommandRule] = &[];
    let (effective_mode, rules, match_decision, no_match_decision) = if !policy.enabled {
        ("unrestricted", empty_rules, "allow", "allow")
    } else {
        match policy.mode {
            crate::models::McpCommandPolicyMode::Allow => {
                ("allow", policy.allow_rules.as_slice(), "allow", "deny")
            }
            crate::models::McpCommandPolicyMode::Exclude => {
                ("exclude", policy.exclude_rules.as_slice(), "deny", "allow")
            }
        }
    };
    json!({
        "sessionId": session_id,
        "groupName": access.group_name,
        "scope": "mcpCommandPolicyOnly",
        "executionRechecksPolicy": true,
        "advancedPolicy": {
            "enabled": policy.enabled,
            "effectiveMode": effective_mode,
            "rules": rules,
            "matchDecision": match_decision,
            "noMatchDecision": no_match_decision,
            "matching": {
                "target": "eachCommandSegment",
                "caseSensitive": true,
                "trimOuterWhitespace": true,
                "globWildcards": ["*", "?"],
                "globEscapes": ["\\*", "\\?", "\\\\"]
            }
        },
        "shellSyntax": crate::mcp_command_policy::shell_syntax_capabilities(policy.enabled),
        "commandInput": {
            "emptyAllowed": false,
            "maxBytes": MAX_COMMAND_BYTES
        }
    })
}

fn permission<'a>(
    permissions: &'a [McpGroupPermission],
    group: &str,
) -> Option<&'a McpGroupPermission> {
    permissions
        .iter()
        .find(|permission| permission.group_name == group && permission.enabled)
}

#[derive(Clone, Copy)]
enum AccessIssue {
    ServiceDisabled,
    GroupDisabled,
    PermissionDenied,
    CommandPolicyDenied,
}

fn localized_access_error(language: &Language, issue: AccessIssue) -> String {
    let message = match (language, issue) {
        (Language::ZhCn, AccessIssue::ServiceDisabled) => "MCP 服务未启用。",
        (Language::ZhCn, AccessIssue::GroupDisabled) => "当前分组未授权。",
        (Language::ZhCn, AccessIssue::PermissionDenied) => "当前工具未获得分组权限。",
        (Language::ZhCn, AccessIssue::CommandPolicyDenied) => "当前命令被高级命令策略拒绝。",
        (Language::EnUs, AccessIssue::ServiceDisabled) => "The MCP service is disabled.",
        (Language::EnUs, AccessIssue::GroupDisabled) => {
            "The current session group is not authorized."
        }
        (Language::EnUs, AccessIssue::PermissionDenied) => {
            "The current tool is not authorized for this session group."
        }
        (Language::EnUs, AccessIssue::CommandPolicyDenied) => {
            "The command was denied by the advanced command policy."
        }
    };
    let hint = if matches!(issue, AccessIssue::CommandPolicyDenied) {
        if matches!(language, Language::EnUs) {
            "Call get_command_policy to inspect the current rules."
        } else {
            "请调用 get_command_policy 查询当前规则。"
        }
    } else if matches!(language, Language::EnUs) {
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

fn localized_unsupported_syntax_error(
    language: &Language,
    kind: crate::mcp_command_policy::UnsupportedShellSyntaxKind,
) -> String {
    if matches!(language, Language::EnUs) {
        format!(
            "The advanced policy does not support this Shell syntax ({}); split the command using error.data.",
            kind.as_str()
        )
    } else {
        format!(
            "高级策略不支持此 Shell 语法（{}）；请按 error.data 拆分命令。",
            kind.as_str()
        )
    }
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
        McpAccessError::UnsupportedSyntax { message, kind } => McpError::invalid_request(
            message,
            Some(crate::mcp_command_policy::unsupported_shell_syntax_data(
                kind,
            )),
        ),
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
        if let Some(candidate) = candidate.filter(|candidate| candidate.starts_with(&root_path)) {
            return Ok(candidate);
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

    #[test]
    fn 语法拒绝返回完整稳定能力范围且不泄露命令位置() {
        let error = mcp_access_error(McpAccessError::UnsupportedSyntax {
            message: localized_unsupported_syntax_error(
                &Language::ZhCn,
                crate::mcp_command_policy::UnsupportedShellSyntaxKind::CommandSubstitution,
            ),
            kind: crate::mcp_command_policy::UnsupportedShellSyntaxKind::CommandSubstitution,
        });
        let data = error.data.expect("语法拒绝应包含结构化能力范围");
        assert_eq!(data["reason"], "unsupportedShellSyntax");
        assert_eq!(data["detectedKind"], "commandSubstitution");
        assert_eq!(
            data["rejectedSyntax"]
                .as_array()
                .expect("拒绝范围应为数组")
                .iter()
                .map(|entry| entry["kind"].as_str().expect("类别应为字符串"))
                .collect::<Vec<_>>(),
            [
                "commandSubstitution",
                "processSubstitution",
                "arithmeticExpansion",
                "subshell",
                "commandGroup",
                "functionDefinition",
                "compoundCommand",
                "hereDocument",
                "malformedSyntax",
                "segmentLimit"
            ]
        );
        assert!(data.get("position").is_none());
        assert!(data.get("range").is_none());
        assert!(data.get("source").is_none());
        assert!(data.get("snippet").is_none());
    }

    #[test]
    fn 命令策略查询只返回生效名单并复用语法能力() {
        let mut access = mcp_permission(true);
        access.command_policy = crate::models::McpCommandPolicy {
            enabled: true,
            mode: crate::models::McpCommandPolicyMode::Allow,
            allow_rules: vec![crate::models::McpCommandRule {
                match_type: crate::models::McpCommandMatchType::Exact,
                pattern: "pwd".to_owned(),
            }],
            exclude_rules: vec![crate::models::McpCommandRule {
                match_type: crate::models::McpCommandMatchType::Glob,
                pattern: "rm *".to_owned(),
            }],
        };

        let allow = command_policy_response("session-a", &access);
        assert_eq!(allow["scope"], "mcpCommandPolicyOnly");
        assert_eq!(allow["executionRechecksPolicy"], true);
        assert_eq!(allow["advancedPolicy"]["effectiveMode"], "allow");
        assert_eq!(allow["advancedPolicy"]["matchDecision"], "allow");
        assert_eq!(allow["advancedPolicy"]["noMatchDecision"], "deny");
        assert_eq!(allow["advancedPolicy"]["rules"][0]["pattern"], "pwd");
        assert!(!allow.to_string().contains("rm *"));
        assert_eq!(allow["shellSyntax"]["enforced"], true);
        assert_eq!(allow["shellSyntax"]["maxSegments"], 256);
        assert_eq!(allow["shellSyntax"]["interpreterArgumentsParsed"], false);
        assert_eq!(allow["commandInput"]["maxBytes"], MAX_COMMAND_BYTES);

        let syntax_error = crate::mcp_command_policy::unsupported_shell_syntax_data(
            crate::mcp_command_policy::UnsupportedShellSyntaxKind::CommandSubstitution,
        );
        assert_eq!(
            allow["shellSyntax"]["supportedSyntax"],
            syntax_error["supportedSyntax"]
        );
        assert_eq!(
            allow["shellSyntax"]["rejectedSyntax"],
            syntax_error["rejectedSyntax"]
        );

        access.command_policy.mode = crate::models::McpCommandPolicyMode::Exclude;
        let exclude = command_policy_response("session-a", &access);
        assert_eq!(exclude["advancedPolicy"]["effectiveMode"], "exclude");
        assert_eq!(exclude["advancedPolicy"]["matchDecision"], "deny");
        assert_eq!(exclude["advancedPolicy"]["noMatchDecision"], "allow");
        assert_eq!(exclude["advancedPolicy"]["rules"][0]["pattern"], "rm *");
        assert!(!exclude.to_string().contains("pwd"));

        access.command_policy.enabled = false;
        let unrestricted = command_policy_response("session-a", &access);
        assert_eq!(
            unrestricted["advancedPolicy"]["effectiveMode"],
            "unrestricted"
        );
        assert_eq!(unrestricted["advancedPolicy"]["rules"], json!([]));
        assert_eq!(unrestricted["shellSyntax"]["enforced"], false);
    }

    #[test]
    fn 写文件审计输入隐藏正文并记录长度和摘要() {
        let input = write_file_audit_input("session-a", "/tmp/file", "secret", false);

        assert_eq!(input["contentOmitted"], true);
        assert_eq!(input["contentBytes"], 6);
        assert_eq!(
            input["contentSha256"],
            "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"
        );
        assert!(input.get("content").is_none());
        assert!(!input.to_string().contains("secret"));
    }

    fn mcp_permission(command_execute: bool) -> McpGroupPermission {
        McpGroupPermission {
            group_name: "生产".to_owned(),
            enabled: true,
            session_read: true,
            file_read: true,
            command_execute,
            file_write: false,
            file_delete: false,
            command_policy: Default::default(),
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
            command_policy: Default::default(),
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
        assert!(prompt.contains(
            "Before execute_command, call get_command_policy for the session; obey its active rules and shellSyntax."
        ));
        assert!(prompt.contains("Chains are checked per segment; split unsupported syntax."));
        assert!(prompt.contains("sh -c, bash -c, and eval arguments are not recursively checked."));
        assert!(prompt
            .contains("Command execution (commandExecute): get_command_policy, execute_command"));
        assert!(!prompt.contains("Advanced command policies support"));
        assert!(!prompt.contains("Nested and compound shell syntax"));
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

        let policy = localized_access_error(&Language::ZhCn, AccessIssue::CommandPolicyDenied);
        assert!(policy.contains("get_command_policy"));
        assert!(!policy.contains("get_permission_guide"));

        let syntax = localized_unsupported_syntax_error(
            &Language::ZhCn,
            crate::mcp_command_policy::UnsupportedShellSyntaxKind::Subshell,
        );
        assert!(syntax.contains("error.data"));
        assert!(syntax.contains("subshell"));
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

    #[test]
    fn 同一服务实例热加载工具输入日志开关() {
        let directory =
            std::env::temp_dir().join(format!("fstty-mcp-audit-setting-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("无法创建测试目录");
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, false, 37_653, Vec::new())
            .expect("保存 MCP 设置失败");
        let state = AppState::new(directory.clone());
        let service = McpService::new(state, "stdio");

        service
            .audit(
                "execute_command",
                Some("session-a"),
                &json!({"command": "secret"}),
            )
            .succeed();
        writer
            .update_log_settings(true)
            .expect("开启工具输入日志失败");
        service
            .audit(
                "execute_command",
                Some("session-a"),
                &json!({"command": "visible"}),
            )
            .succeed();

        let content = std::fs::read_dir(directory.join("logs"))
            .expect("应读取日志目录")
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mcp-audit-")
            })
            .and_then(|entry| std::fs::read_to_string(entry.path()).ok())
            .expect("应读取审计日志");
        assert!(!content.contains("secret"));
        assert!(content.contains("input: command=\"visible\""));
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
        assert!(stdio
            .get_command_policy(Parameters(SessionArgs {
                session_id: session_id.clone(),
            }))
            .await
            .is_err());

        stdio
            .state
            .mcp_command_policy_service
            .lock()
            .expect("策略服务应可锁定")
            .replace_all(vec![mcp_permission(true)])
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

        stdio
            .state
            .mcp_command_policy_service
            .lock()
            .expect("策略服务应可锁定")
            .replace_all(vec![mcp_permission(false)])
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

    #[tokio::test]
    async fn stdio和http热加载高级命令策略() {
        let directory =
            std::env::temp_dir().join(format!("fstty-command-policy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("无法创建测试目录");
        let session_id = Uuid::new_v4().to_string();
        write_test_session(&directory, &session_id);
        let mut writer = SettingsService::load(&directory);
        let mut permission = mcp_permission(true);
        permission.command_policy = crate::models::McpCommandPolicy {
            enabled: true,
            mode: crate::models::McpCommandPolicyMode::Allow,
            allow_rules: vec![crate::models::McpCommandRule {
                match_type: crate::models::McpCommandMatchType::Glob,
                pattern: "git status *".to_owned(),
            }],
            exclude_rules: vec![crate::models::McpCommandRule {
                match_type: crate::models::McpCommandMatchType::Glob,
                pattern: "rm *".to_owned(),
            }],
        };
        writer
            .update_mcp(true, true, 37_653, vec![permission.clone()])
            .expect("保存高级命令策略失败");

        let state = AppState::new(directory.clone());
        let stdio = McpService::new(state.clone(), "stdio");
        let transfers = McpTransferRuntime::new(state.clone(), 37_653, CancellationToken::new());
        let http = McpService::new_http(state, transfers);
        for service in [&stdio, &http] {
            let policy_result = service
                .get_command_policy(Parameters(SessionArgs {
                    session_id: session_id.clone(),
                }))
                .await
                .expect("查询命令策略应成功");
            assert_eq!(
                policy_result
                    .structured_content
                    .as_ref()
                    .expect("应返回结构化策略")["advancedPolicy"]["effectiveMode"],
                "allow"
            );
            assert!(
                authorized_command_session(&service.state, &session_id, "git status --short")
                    .await
                    .is_ok()
            );
            assert!(authorized_command_session(
                &service.state,
                &session_id,
                "git status --short && git status --branch"
            )
            .await
            .is_ok());
            assert!(matches!(
                authorized_command_session(&service.state, &session_id, "rm -rf /tmp/demo").await,
                Err(McpAccessError::Forbidden(_))
            ));
            assert!(matches!(
                authorized_command_session(
                    &service.state,
                    &session_id,
                    "git status --short && rm -rf /tmp/demo"
                )
                .await,
                Err(McpAccessError::Forbidden(_))
            ));
            assert!(matches!(
                authorized_command_session(&service.state, &session_id, "echo $(pwd)").await,
                Err(McpAccessError::UnsupportedSyntax {
                    kind:
                        crate::mcp_command_policy::UnsupportedShellSyntaxKind::CommandSubstitution,
                    ..
                })
            ));
        }

        permission.command_policy.mode = crate::models::McpCommandPolicyMode::Exclude;
        stdio
            .state
            .mcp_command_policy_service
            .lock()
            .expect("策略服务应可锁定")
            .replace_all(vec![permission])
            .expect("切换排除模式失败");
        let refreshed = stdio
            .get_command_policy(Parameters(SessionArgs {
                session_id: session_id.clone(),
            }))
            .await
            .expect("应热加载黑名单");
        assert_eq!(
            refreshed
                .structured_content
                .as_ref()
                .expect("应返回结构化策略")["advancedPolicy"]["effectiveMode"],
            "exclude"
        );
        assert!(matches!(
            authorized_command_session(&stdio.state, &session_id, "rm -rf /tmp/demo").await,
            Err(McpAccessError::Forbidden(_))
        ));
        assert!(
            authorized_command_session(&stdio.state, &session_id, "git status --short")
                .await
                .is_ok()
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 策略数据库异常时命令授权失败关闭() {
        let directory =
            std::env::temp_dir().join(format!("fstty-command-policy-failed-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("无法创建测试目录");
        let session_id = Uuid::new_v4().to_string();
        write_test_session(&directory, &session_id);
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, false, 37_653, vec![mcp_permission(true)])
            .expect("保存初始权限失败");
        let connection = rusqlite::Connection::open(directory.join("mcp-command-policy.v1.db"))
            .expect("应创建策略数据库");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("应写入未来版本");
        drop(connection);

        let state = AppState::new(directory.clone());
        assert!(matches!(
            authorized_command_session(&state, &session_id, "pwd").await,
            Err(McpAccessError::Internal(_))
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
        assert!(stdio.tool_router.has_route("get_command_policy"));
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
        assert!(http.tool_router.has_route("get_command_policy"));
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
