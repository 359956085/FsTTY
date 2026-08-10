use crate::mcp::{authorized_session, McpAccessError, Permission};
use crate::models::AppError;
use crate::services::AppState;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, put},
    Router,
};
use serde_json::json;
use std::{
    collections::HashMap,
    io,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::duplex;
use tokio::sync::{Mutex, Semaphore};
use tokio_stream::StreamExt;
use tokio_util::{
    io::{ReaderStream, StreamReader},
    sync::CancellationToken,
};
use uuid::Uuid;

mod range;
mod ticket;

use range::parse_range_headers;
#[cfg(test)]
use range::{parse_range, ByteRange};
use ticket::{IssuedTransferLink, TransferTicket, TransferTicketKind, TransferTicketState};

const TICKET_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_TICKETS: usize = 256;
const MAX_ACTIVE_TRANSFERS: usize = 4;
const TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_PIPE_BYTES: usize = 4 * 64 * 1024;

const CONTENT_SECURITY_POLICY: HeaderName = HeaderName::from_static("content-security-policy");
const REFERRER_POLICY: HeaderName = HeaderName::from_static("referrer-policy");
const X_CONTENT_TYPE_OPTIONS: HeaderName = HeaderName::from_static("x-content-type-options");
const X_FRAME_OPTIONS: HeaderName = HeaderName::from_static("x-frame-options");

#[derive(Clone)]
pub(crate) struct McpTransferRuntime {
    inner: Arc<McpTransferRuntimeInner>,
}

struct McpTransferRuntimeInner {
    state: AppState,
    port: u16,
    tickets: Mutex<HashMap<String, TransferTicket>>,
    transfers: Arc<Semaphore>,
    shutdown: CancellationToken,
}

impl McpTransferRuntime {
    pub(crate) fn new(state: AppState, port: u16, shutdown: CancellationToken) -> Self {
        Self {
            inner: Arc::new(McpTransferRuntimeInner {
                state,
                port,
                tickets: Mutex::new(HashMap::new()),
                transfers: Arc::new(Semaphore::new(MAX_ACTIVE_TRANSFERS)),
                shutdown,
            }),
        }
    }

    pub(crate) fn port(&self) -> u16 {
        self.inner.port
    }

    pub(crate) fn router(&self) -> Router {
        Router::new()
            .route(
                "/downloads/{ticket}",
                get(download_file).head(head_download_file),
            )
            .route(
                "/uploads/{ticket}",
                get(upload_page).put(upload_without_file_name),
            )
            .route("/uploads/{ticket}/{file_name}", put(upload_file))
            .with_state(self.clone())
    }

    pub(crate) async fn issue_download(
        &self,
        base_url: &str,
        session_id: String,
        remote_path: String,
        file_name: String,
    ) -> Result<IssuedTransferLink, AppError> {
        self.issue(
            base_url,
            "downloads",
            session_id,
            TransferTicketKind::Download {
                remote_path,
                file_name,
            },
        )
        .await
    }

    pub(crate) async fn issue_upload(
        &self,
        base_url: &str,
        session_id: String,
        remote_directory: String,
    ) -> Result<IssuedTransferLink, AppError> {
        self.issue(
            base_url,
            "uploads",
            session_id,
            TransferTicketKind::Upload { remote_directory },
        )
        .await
    }

    async fn issue(
        &self,
        base_url: &str,
        route: &str,
        session_id: String,
        kind: TransferTicketKind,
    ) -> Result<IssuedTransferLink, AppError> {
        let now = Instant::now();
        let mut tickets = self.inner.tickets.lock().await;
        prune_expired(&mut tickets, now);
        if tickets.len() >= MAX_TICKETS {
            return Err(AppError::Busy("一次性传输链接数量已达上限".to_owned()));
        }
        let token = new_ticket_token();
        tickets.insert(
            token.clone(),
            TransferTicket {
                session_id,
                kind,
                expires_at: now + TICKET_TTL,
                state: TransferTicketState::Ready,
                cancellation: CancellationToken::new(),
            },
        );
        let expires_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            + TICKET_TTL.as_millis();
        Ok(IssuedTransferLink {
            url: format!("{}/{route}/{token}", base_url.trim_end_matches('/')),
            expires_in_seconds: TICKET_TTL.as_secs(),
            expires_at_unix_ms,
        })
    }

    pub(crate) async fn clear(&self) {
        let mut tickets = self.inner.tickets.lock().await;
        for ticket in tickets.values() {
            ticket.cancellation.cancel();
        }
        tickets.clear();
    }

    #[cfg(test)]
    pub(crate) async fn ticket_count(&self) -> usize {
        self.inner.tickets.lock().await.len()
    }

    async fn peek_download(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.peek(token, false).await
    }

    async fn peek_upload(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.peek(token, true).await
    }

    async fn peek(&self, token: &str, upload: bool) -> Result<TransferTicket, StatusCode> {
        let mut tickets = self.inner.tickets.lock().await;
        prune_expired(&mut tickets, Instant::now());
        let ticket = tickets.get(token).ok_or(StatusCode::NOT_FOUND)?;
        let kind_matches = matches!(
            (&ticket.kind, upload),
            (TransferTicketKind::Download { .. }, false)
                | (TransferTicketKind::Upload { .. }, true)
        );
        kind_matches
            .then(|| ticket.clone())
            .ok_or(StatusCode::NOT_FOUND)
    }

    async fn begin_download(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.begin(token, false).await
    }

    async fn begin_upload(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.begin(token, true).await
    }

    async fn begin(&self, token: &str, upload: bool) -> Result<TransferTicket, StatusCode> {
        let mut tickets = self.inner.tickets.lock().await;
        prune_expired(&mut tickets, Instant::now());
        let ticket = tickets.get_mut(token).ok_or(StatusCode::NOT_FOUND)?;
        let kind_matches = matches!(
            (&ticket.kind, upload),
            (TransferTicketKind::Download { .. }, false)
                | (TransferTicketKind::Upload { .. }, true)
        );
        if !kind_matches {
            return Err(StatusCode::NOT_FOUND);
        }
        if ticket.state == TransferTicketState::Active {
            return Err(StatusCode::CONFLICT);
        }
        ticket.state = TransferTicketState::Active;
        Ok(ticket.clone())
    }

    async fn finish_download(&self, token: &str) {
        let mut tickets = self.inner.tickets.lock().await;
        let remove = tickets
            .get(token)
            .is_some_and(|ticket| ticket.expires_at <= Instant::now());
        if remove {
            tickets.remove(token);
        } else if let Some(ticket) = tickets.get_mut(token) {
            ticket.state = TransferTicketState::Ready;
        }
    }

    async fn finish_upload(&self, token: &str, succeeded: bool) {
        let mut tickets = self.inner.tickets.lock().await;
        let remove = succeeded
            || tickets
                .get(token)
                .is_some_and(|ticket| ticket.expires_at <= Instant::now());
        if remove {
            tickets.remove(token);
        } else if let Some(ticket) = tickets.get_mut(token) {
            ticket.state = TransferTicketState::Ready;
        }
    }

    fn combined_cancellation(
        &self,
        ticket_cancellation: CancellationToken,
    ) -> (CancellationToken, tokio::task::JoinHandle<()>) {
        let combined = CancellationToken::new();
        let signal = combined.clone();
        let shutdown = self.inner.shutdown.clone();
        let watcher = tokio::spawn(async move {
            tokio::select! {
                _ = ticket_cancellation.cancelled() => {}
                _ = shutdown.cancelled() => {}
            }
            signal.cancel();
        });
        (combined, watcher)
    }
}

fn prune_expired(tickets: &mut HashMap<String, TransferTicket>, now: Instant) {
    tickets.retain(|_, ticket| {
        let keep = ticket.state == TransferTicketState::Active || ticket.expires_at > now;
        if !keep {
            ticket.cancellation.cancel();
        }
        keep
    });
}

fn new_ticket_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub(crate) fn http_base_url(headers: &HeaderMap, port: u16) -> Result<String, AppError> {
    let host = headers
        .get(header::HOST)
        .ok_or_else(|| AppError::Validation("HTTP 请求缺少 Host".to_owned()))?
        .to_str()
        .map_err(|_| AppError::Validation("HTTP Host 无效".to_owned()))?;
    let authority = host
        .parse::<axum::http::uri::Authority>()
        .map_err(|_| AppError::Validation("HTTP Host 无效".to_owned()))?;
    if authority.port_u16().unwrap_or(80) != port {
        return Err(AppError::Validation(
            "HTTP Host 端口与 MCP 服务不一致".to_owned(),
        ));
    }
    Ok(format!("http://{authority}"))
}

async fn head_download_file(
    State(runtime): State<McpTransferRuntime>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    download_response(runtime, token, headers, true).await
}

async fn download_file(
    State(runtime): State<McpTransferRuntime>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    download_response(runtime, token, headers, false).await
}

async fn download_response(
    runtime: McpTransferRuntime,
    token: String,
    headers: HeaderMap,
    head_only: bool,
) -> Response {
    let ticket = if head_only {
        runtime.peek_download(&token).await
    } else {
        runtime.begin_download(&token).await
    };
    let ticket = match ticket {
        Ok(ticket) => ticket,
        Err(status) => return ticket_error_response(status),
    };
    let started = Instant::now();
    let tool = if head_only {
        "download_link_head"
    } else {
        "download_link_transfer"
    };
    let permit = match runtime.inner.transfers.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            if !head_only {
                runtime.finish_download(&token).await;
            }
            record_transfer(&runtime, tool, &ticket.session_id, false, started);
            return error_response(StatusCode::TOO_MANY_REQUESTS, "活动传输数量已达上限");
        }
    };
    let session = match authorized_session(
        &runtime.inner.state,
        &ticket.session_id,
        Permission::FileTransfer,
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            if !head_only {
                runtime.finish_download(&token).await;
            }
            record_transfer(&runtime, tool, &ticket.session_id, false, started);
            return access_error_response(error);
        }
    };
    let connection = match runtime
        .inner
        .state
        .connection_manager
        .connect_headless(session, &runtime.inner.state.credential_service)
        .await
    {
        Ok(connection) => connection,
        Err(error) => {
            if !head_only {
                runtime.finish_download(&token).await;
            }
            record_transfer(&runtime, tool, &ticket.session_id, false, started);
            return app_error_response(error);
        }
    };
    let (remote_path, file_name) = match &ticket.kind {
        TransferTicketKind::Download {
            remote_path,
            file_name,
        } => (remote_path.clone(), file_name.clone()),
        TransferTicketKind::Upload { .. } => unreachable!("已校验下载票据"),
    };
    let info = runtime
        .inner
        .state
        .connection_manager
        .remote_file_info(&connection.connection_id, &remote_path)
        .await;
    let (remote_path, size) = match info {
        Ok(info) => info,
        Err(error) => {
            let _ = runtime
                .inner
                .state
                .connection_manager
                .disconnect(&connection.connection_id)
                .await;
            if !head_only {
                runtime.finish_download(&token).await;
            }
            record_transfer(&runtime, tool, &ticket.session_id, false, started);
            return app_error_response(error);
        }
    };
    let range = match parse_range_headers(&headers, size) {
        Ok(range) => range,
        Err(()) => {
            let _ = runtime
                .inner
                .state
                .connection_manager
                .disconnect(&connection.connection_id)
                .await;
            if !head_only {
                runtime.finish_download(&token).await;
            }
            record_transfer(&runtime, tool, &ticket.session_id, false, started);
            return range_error_response(size);
        }
    };
    let (status, offset, length) = match range {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.offset, range.length),
        None => (StatusCode::OK, 0, size),
    };

    if head_only {
        let _ = runtime
            .inner
            .state
            .connection_manager
            .disconnect(&connection.connection_id)
            .await;
        drop(permit);
        record_transfer(&runtime, tool, &ticket.session_id, true, started);
        return download_http_response(status, &file_name, size, offset, length, Body::empty());
    }

    let (reader, mut writer) = duplex(DOWNLOAD_PIPE_BYTES);
    let body = Body::from_stream(ReaderStream::new(reader));
    let response = download_http_response(status, &file_name, size, offset, length, body);
    let task_runtime = runtime.clone();
    let task_token = token.clone();
    let task_session_id = ticket.session_id.clone();
    let connection_id = connection.connection_id.clone();
    let ticket_cancellation = ticket.cancellation.clone();
    tokio::spawn(async move {
        let (cancellation, watcher) = task_runtime.combined_cancellation(ticket_cancellation);
        let result = task_runtime
            .inner
            .state
            .connection_manager
            .stream_remote_file(
                &connection_id,
                &remote_path,
                (offset, length),
                &mut writer,
                &cancellation,
                TRANSFER_IDLE_TIMEOUT,
            )
            .await;
        watcher.abort();
        drop(writer);
        let _ = task_runtime
            .inner
            .state
            .connection_manager
            .disconnect(&connection_id)
            .await;
        task_runtime.finish_download(&task_token).await;
        record_transfer(
            &task_runtime,
            "download_link_transfer",
            &task_session_id,
            result.is_ok(),
            started,
        );
        drop(permit);
    });
    response
}

fn download_http_response(
    status: StatusCode,
    file_name: &str,
    total_size: u64,
    offset: u64,
    length: u64,
    body: Body,
) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("文件长度应为有效请求头"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(file_name))
            .expect("已清洗的文件名应为有效请求头"),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        let end = offset + length - 1;
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {offset}-{end}/{total_size}"))
                .expect("文件区间应为有效请求头"),
        );
    }
    apply_data_security_headers(headers);
    response
}

fn content_disposition(file_name: &str) -> String {
    let fallback = file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let fallback = if fallback.is_empty() {
        "download".to_owned()
    } else {
        fallback
    };
    format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{}",
        percent_encode(file_name)
    )
}

fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            output.push(char::from(byte));
        } else {
            output.push('%');
            output.push_str(&format!("{byte:02X}"));
        }
    }
    output
}

async fn upload_page(
    State(runtime): State<McpTransferRuntime>,
    Path(token): Path<String>,
) -> Response {
    let ticket = match runtime.peek_upload(&token).await {
        Ok(ticket) => ticket,
        Err(status) => return ticket_error_response(status),
    };
    let remote_directory = match ticket.kind {
        TransferTicketKind::Upload { remote_directory } => remote_directory,
        TransferTicketKind::Download { .. } => unreachable!("已校验上传票据"),
    };
    let html = UPLOAD_PAGE.replace("__REMOTE_DIRECTORY__", &html_escape(&remote_directory));
    let mut response = Html(html).into_response();
    let headers = response.headers_mut();
    apply_data_security_headers(headers);
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

async fn upload_without_file_name(
    State(runtime): State<McpTransferRuntime>,
    Path(token): Path<String>,
) -> Response {
    if let Err(status) = runtime.peek_upload(&token).await {
        return ticket_error_response(status);
    }
    error_response(StatusCode::BAD_REQUEST, "上传 URL 缺少文件名")
}

async fn upload_file(
    State(runtime): State<McpTransferRuntime>,
    Path((token, file_name)): Path<(String, String)>,
    body: Body,
) -> Response {
    let ticket = match runtime.begin_upload(&token).await {
        Ok(ticket) => ticket,
        Err(status) => return ticket_error_response(status),
    };
    let started = Instant::now();
    let permit = match runtime.inner.transfers.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            runtime.finish_upload(&token, false).await;
            record_transfer(
                &runtime,
                "upload_link_transfer",
                &ticket.session_id,
                false,
                started,
            );
            return error_response(StatusCode::TOO_MANY_REQUESTS, "活动传输数量已达上限");
        }
    };
    let session = match authorized_session(
        &runtime.inner.state,
        &ticket.session_id,
        Permission::FileTransfer,
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            runtime.finish_upload(&token, false).await;
            record_transfer(
                &runtime,
                "upload_link_transfer",
                &ticket.session_id,
                false,
                started,
            );
            return access_error_response(error);
        }
    };
    let connection = match runtime
        .inner
        .state
        .connection_manager
        .connect_headless(session, &runtime.inner.state.credential_service)
        .await
    {
        Ok(connection) => connection,
        Err(error) => {
            runtime.finish_upload(&token, false).await;
            record_transfer(
                &runtime,
                "upload_link_transfer",
                &ticket.session_id,
                false,
                started,
            );
            return app_error_response(error);
        }
    };
    let remote_directory = match &ticket.kind {
        TransferTicketKind::Upload { remote_directory } => remote_directory.clone(),
        TransferTicketKind::Download { .. } => unreachable!("已校验上传票据"),
    };
    let stream = body.into_data_stream().map(|result| {
        result.map_err(|error| io::Error::new(io::ErrorKind::ConnectionAborted, error))
    });
    let mut reader = StreamReader::new(stream);
    let (cancellation, watcher) = runtime.combined_cancellation(ticket.cancellation.clone());
    let result = runtime
        .inner
        .state
        .connection_manager
        .upload_remote_stream_exclusive(
            &connection.connection_id,
            &remote_directory,
            &file_name,
            &mut reader,
            &cancellation,
            TRANSFER_IDLE_TIMEOUT,
        )
        .await;
    watcher.abort();
    let _ = runtime
        .inner
        .state
        .connection_manager
        .disconnect(&connection.connection_id)
        .await;
    let succeeded = result.is_ok();
    runtime.finish_upload(&token, succeeded).await;
    record_transfer(
        &runtime,
        "upload_link_transfer",
        &ticket.session_id,
        succeeded,
        started,
    );
    drop(permit);

    match result {
        Ok((remote_path, bytes)) => json_response(
            StatusCode::CREATED,
            json!({
                "ok": true,
                "fileName": file_name,
                "remotePath": remote_path,
                "bytes": bytes,
            }),
        ),
        Err(error) => app_error_response(error),
    }
}

fn record_transfer(
    runtime: &McpTransferRuntime,
    tool: &str,
    session_id: &str,
    succeeded: bool,
    started: Instant,
) {
    runtime.inner.state.mcp_audit_service.record(
        "http-transfer",
        tool,
        Some(session_id),
        if succeeded { "success" } else { "error" },
        started.elapsed(),
        None,
    );
}

fn access_error_response(error: McpAccessError) -> Response {
    match error {
        McpAccessError::NotFound(message) => error_response(StatusCode::NOT_FOUND, &message),
        McpAccessError::Forbidden(message) => error_response(StatusCode::FORBIDDEN, &message),
        McpAccessError::Internal(message) => {
            error_response(StatusCode::INTERNAL_SERVER_ERROR, &message)
        }
        McpAccessError::UnsupportedSyntax { message, .. } => {
            error_response(StatusCode::BAD_REQUEST, &message)
        }
    }
}

fn app_error_response(error: AppError) -> Response {
    let message = error.to_string();
    let status = match error {
        AppError::Validation(_) => StatusCode::BAD_REQUEST,
        AppError::NotFound(_) => StatusCode::NOT_FOUND,
        AppError::Conflict(_) => StatusCode::CONFLICT,
        AppError::Busy(_) => StatusCode::TOO_MANY_REQUESTS,
        AppError::Persistence(_) | AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        AppError::Credential(_)
        | AppError::Authentication(_)
        | AppError::AuthenticationInterrupted(_)
        | AppError::AuthenticationRejected(_)
        | AppError::Connection(_)
        | AppError::Sftp(_) => {
            if message.contains("超时") {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::BAD_GATEWAY
            }
        }
    };
    error_response(status, &message)
}

fn ticket_error_response(status: StatusCode) -> Response {
    let message = if status == StatusCode::CONFLICT {
        "该链接已有传输正在进行"
    } else {
        "传输链接不存在或已过期"
    };
    error_response(status, message)
}

fn range_error_response(size: u64) -> Response {
    let mut response = error_response(StatusCode::RANGE_NOT_SATISFIABLE, "下载区间无效");
    response.headers_mut().insert(
        header::CONTENT_RANGE,
        HeaderValue::from_str(&format!("bytes */{size}")).expect("文件长度应为有效请求头"),
    );
    response
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    let mut response = (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response();
    apply_data_security_headers(response.headers_mut());
    response
}

fn error_response(status: StatusCode, message: &str) -> Response {
    let mut response = json_response(status, json!({ "error": message }));
    if status == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    response
}

fn apply_data_security_headers(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

const UPLOAD_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FsTTY 上传文件 / Upload file</title>
  <style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}
    body{max-width:42rem;margin:4rem auto;padding:0 1.25rem}
    main{border:1px solid #8886;border-radius:12px;padding:1.5rem}
    button,input{font:inherit}button{margin-top:1rem;padding:.6rem 1rem}
    progress{display:block;width:100%;margin-top:1rem}
    #status{min-height:1.5rem;white-space:pre-wrap}
    code{overflow-wrap:anywhere}
  </style>
</head>
<body>
  <main>
    <h1>上传文件 / Upload file</h1>
    <p>目标目录 / Destination: <code>__REMOTE_DIRECTORY__</code></p>
    <p>链接本身即凭据，5 分钟有效，首次成功后失效。不会覆盖已有文件。<br>
       This link is the credential, remains valid for 5 minutes, and expires after the first successful upload. Existing files are never overwritten.</p>
    <input id="file" type="file">
    <button id="upload" type="button">开始上传 / Upload</button>
    <progress id="progress" max="100" value="0"></progress>
    <p id="status" role="status"></p>
  </main>
  <script>
    const fileInput = document.getElementById("file");
    const uploadButton = document.getElementById("upload");
    const progress = document.getElementById("progress");
    const status = document.getElementById("status");
    uploadButton.addEventListener("click", () => {
      const file = fileInput.files[0];
      if (!file) {
        status.textContent = "请选择文件 / Select a file.";
        return;
      }
      uploadButton.disabled = true;
      progress.value = 0;
      status.textContent = `${file.name} · ${file.size} bytes`;
      const request = new XMLHttpRequest();
      request.open("PUT", `${location.pathname}/${encodeURIComponent(file.name)}`);
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.upload.addEventListener("progress", event => {
        if (event.lengthComputable) progress.value = event.loaded / event.total * 100;
      });
      request.addEventListener("load", () => {
        if (request.status === 201) {
          progress.value = 100;
          status.textContent = "上传完成 / Upload complete.";
          fileInput.disabled = true;
        } else {
          status.textContent = request.responseText || `HTTP ${request.status}`;
          uploadButton.disabled = false;
        }
      });
      request.addEventListener("error", () => {
        status.textContent = "上传失败，可在链接有效期内重试 / Upload failed; retry while the link remains valid.";
        uploadButton.disabled = false;
      });
      request.send(file);
    });
  </script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::McpGroupPermission;
    use crate::services::SettingsService;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_runtime() -> (McpTransferRuntime, PathBuf) {
        let directory = std::env::temp_dir().join(format!("fstty-mcp-transfer-{}", Uuid::new_v4()));
        let state = AppState::new(directory.clone());
        (
            McpTransferRuntime::new(state, 37_653, CancellationToken::new()),
            directory,
        )
    }

    fn token_from_url(url: &str) -> String {
        url.rsplit('/').next().expect("链接应包含票据").to_owned()
    }

    fn permission_runtime() -> (McpTransferRuntime, PathBuf, String) {
        let directory =
            std::env::temp_dir().join(format!("fstty-mcp-transfer-auth-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("无法创建测试目录");
        let session_id = Uuid::new_v4().to_string();
        let sessions = json!({
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
            serde_json::to_vec_pretty(&sessions).expect("无法序列化测试会话"),
        )
        .expect("无法写入测试会话");
        let mut settings = SettingsService::load(&directory);
        settings
            .update_mcp(
                true,
                true,
                37_653,
                vec![McpGroupPermission {
                    group_name: "生产".to_owned(),
                    enabled: true,
                    session_read: true,
                    file_read: true,
                    file_transfer: true,
                    command_execute: false,
                    file_write: true,
                    file_delete: false,
                    command_policy: Default::default(),
                }],
            )
            .expect("无法保存初始传输权限");
        let state = AppState::new(directory.clone());
        (
            McpTransferRuntime::new(state, 37_653, CancellationToken::new()),
            directory,
            session_id,
        )
    }

    #[test]
    fn host生成地址时校验端口() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "192.168.22.141:37653".parse().unwrap());
        headers.insert(
            HeaderName::from_static("x-forwarded-host"),
            "evil.example".parse().unwrap(),
        );

        assert_eq!(
            http_base_url(&headers, 37_653).unwrap(),
            "http://192.168.22.141:37653"
        );
        assert!(http_base_url(&headers, 37_654).is_err());
        assert!(http_base_url(&HeaderMap::new(), 37_653).is_err());
    }

    #[test]
    fn 单区间下载解析完整() {
        let header = |value: &'static str| HeaderValue::from_static(value);
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(
            parse_range(Some(&header("bytes=0-9")), 100),
            Ok(Some(ByteRange {
                offset: 0,
                length: 10
            }))
        );
        assert_eq!(
            parse_range(Some(&header("bytes=90-")), 100),
            Ok(Some(ByteRange {
                offset: 90,
                length: 10
            }))
        );
        assert_eq!(
            parse_range(Some(&header("bytes=-10")), 100),
            Ok(Some(ByteRange {
                offset: 90,
                length: 10
            }))
        );
        assert_eq!(
            parse_range(Some(&header("bytes=90-999")), 100),
            Ok(Some(ByteRange {
                offset: 90,
                length: 10
            }))
        );
    }

    #[test]
    fn 多区间和越界区间被拒绝() {
        let multi = HeaderValue::from_static("bytes=0-1,4-5");
        let beyond = HeaderValue::from_static("bytes=100-");
        let reversed = HeaderValue::from_static("bytes=10-9");
        assert_eq!(parse_range(Some(&multi), 100), Err(()));
        assert_eq!(parse_range(Some(&beyond), 100), Err(()));
        assert_eq!(parse_range(Some(&reversed), 100), Err(()));
        assert_eq!(
            parse_range(Some(&HeaderValue::from_static("bytes=0-0")), 0),
            Err(())
        );
        let mut headers = HeaderMap::new();
        headers.append(header::RANGE, HeaderValue::from_static("bytes=0-1"));
        headers.append(header::RANGE, HeaderValue::from_static("bytes=4-5"));
        assert_eq!(parse_range_headers(&headers, 100), Err(()));
    }

    #[test]
    fn unicode文件名使用安全下载头() {
        let value = content_disposition("部署 包.zip");
        assert!(value.contains("filename=\"____.zip\""));
        assert!(value.contains("filename*=UTF-8''%E9%83%A8%E7%BD%B2%20%E5%8C%85.zip"));
        assert!(HeaderValue::from_str(&value).is_ok());
    }

    #[tokio::test]
    async fn 下载票据允许顺序重试但拒绝并发() {
        let (runtime, directory) = test_runtime();
        let link = runtime
            .issue_download(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp/report.txt".to_owned(),
                "report.txt".to_owned(),
            )
            .await
            .unwrap();
        let token = token_from_url(&link.url);

        assert!(runtime.begin_download(&token).await.is_ok());
        assert_eq!(
            runtime.begin_download(&token).await.unwrap_err(),
            StatusCode::CONFLICT
        );
        runtime.finish_download(&token).await;
        assert!(runtime.begin_download(&token).await.is_ok());
        runtime.finish_download(&token).await;

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 上传成功消费票据而失败允许重试() {
        let (runtime, directory) = test_runtime();
        let link = runtime
            .issue_upload(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp".to_owned(),
            )
            .await
            .unwrap();
        let token = token_from_url(&link.url);

        assert!(runtime.begin_upload(&token).await.is_ok());
        runtime.finish_upload(&token, false).await;
        assert!(runtime.begin_upload(&token).await.is_ok());
        runtime.finish_upload(&token, true).await;
        assert_eq!(
            runtime.peek_upload(&token).await.unwrap_err(),
            StatusCode::NOT_FOUND
        );

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 下载和上传请求热加载撤销后的权限() {
        let (runtime, directory, session_id) = permission_runtime();
        let download = runtime
            .issue_download(
                "http://127.0.0.1:37653",
                session_id.clone(),
                "/tmp/report.txt".to_owned(),
                "report.txt".to_owned(),
            )
            .await
            .expect("无法签发下载票据");
        let upload = runtime
            .issue_upload("http://127.0.0.1:37653", session_id, "/tmp".to_owned())
            .await
            .expect("无法签发上传票据");
        runtime
            .inner
            .state
            .mcp_command_policy_service
            .lock()
            .expect("策略服务应可锁定")
            .replace_all(vec![McpGroupPermission {
                group_name: "生产".to_owned(),
                enabled: true,
                session_read: true,
                file_read: true,
                file_transfer: false,
                command_execute: false,
                file_write: true,
                file_delete: false,
                command_policy: Default::default(),
            }])
            .expect("无法撤销传输权限");

        let download_token = token_from_url(&download.url);
        let head = head_download_file(
            State(runtime.clone()),
            Path(download_token.clone()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(head.status(), StatusCode::FORBIDDEN);
        let get = download_file(
            State(runtime.clone()),
            Path(download_token),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(get.status(), StatusCode::FORBIDDEN);

        let put = upload_file(
            State(runtime),
            Path((token_from_url(&upload.url), "report.txt".to_owned())),
            Body::empty(),
        )
        .await;
        assert_eq!(put.status(), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 过期和清理会撤销票据() {
        let (runtime, directory) = test_runtime();
        let link = runtime
            .issue_download(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp/report.txt".to_owned(),
                "report.txt".to_owned(),
            )
            .await
            .unwrap();
        let token = token_from_url(&link.url);
        {
            let mut tickets = runtime.inner.tickets.lock().await;
            tickets.get_mut(&token).unwrap().expires_at = Instant::now();
        }
        assert_eq!(
            runtime.peek_download(&token).await.unwrap_err(),
            StatusCode::NOT_FOUND
        );

        let second = runtime
            .issue_upload(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp".to_owned(),
            )
            .await
            .unwrap();
        let second_token = token_from_url(&second.url);
        let active = runtime.begin_upload(&second_token).await.unwrap();
        runtime.clear().await;
        assert!(active.cancellation.is_cancelled());
        assert_eq!(
            runtime.peek_upload(&second_token).await.unwrap_err(),
            StatusCode::NOT_FOUND
        );

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 票据数量有固定上限() {
        let (runtime, directory) = test_runtime();
        for index in 0..MAX_TICKETS {
            runtime
                .issue_download(
                    "http://127.0.0.1:37653",
                    format!("session-{index}"),
                    "/tmp/report.txt".to_owned(),
                    "report.txt".to_owned(),
                )
                .await
                .unwrap();
        }
        assert!(matches!(
            runtime
                .issue_upload(
                    "http://127.0.0.1:37653",
                    "overflow".to_owned(),
                    "/tmp".to_owned(),
                )
                .await,
            Err(AppError::Busy(_))
        ));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 上传页面包含安全头且不加载外部资源() {
        let (runtime, directory) = test_runtime();
        let link = runtime
            .issue_upload(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp/<private>".to_owned(),
            )
            .await
            .unwrap();
        let token = token_from_url(&link.url);
        let response = upload_page(State(runtime), Path(token)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        assert_eq!(response.headers().get(X_FRAME_OPTIONS).unwrap(), "DENY");
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("/tmp/&lt;private&gt;"));
        assert!(!html.contains("src=\"http"));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 上传页面路由无需_bearer_且允许浏览器_origin() {
        let (runtime, directory) = test_runtime();
        let link = runtime
            .issue_upload(
                "http://127.0.0.1:37653",
                "session-a".to_owned(),
                "/tmp".to_owned(),
            )
            .await
            .unwrap();
        let token = token_from_url(&link.url);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = runtime.router();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /uploads/{token} HTTP/1.1\r\nHost: {address}\r\nOrigin: http://{address}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8_lossy(&response);
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("cache-control: no-store"));
        assert!(response.contains("content-security-policy:"));
        server.abort();

        let _ = std::fs::remove_dir_all(directory);
    }
}
