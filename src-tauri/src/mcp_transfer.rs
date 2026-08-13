use crate::models::AppError;
use crate::services::AppState;
use axum::{http::StatusCode, Router};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

mod http;
mod range;
mod ticket;

pub(crate) use http::http_base_url;
#[cfg(test)]
use range::{parse_range, parse_range_headers, ByteRange};
use ticket::{IssuedTransferLink, TicketStore, TransferTicket, TransferTicketKind};

const TICKET_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_TICKETS: usize = 256;
const MAX_ACTIVE_TRANSFERS: usize = 4;
const TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_PIPE_BYTES: usize = 4 * 64 * 1024;

#[derive(Clone)]
pub(crate) struct McpTransferRuntime {
    inner: Arc<McpTransferRuntimeInner>,
}

struct McpTransferRuntimeInner {
    state: AppState,
    port: u16,
    tickets: TicketStore,
    transfers: Arc<Semaphore>,
    shutdown: CancellationToken,
}

impl McpTransferRuntime {
    pub(crate) fn new(state: AppState, port: u16, shutdown: CancellationToken) -> Self {
        Self {
            inner: Arc::new(McpTransferRuntimeInner {
                state,
                port,
                tickets: TicketStore::new(MAX_TICKETS),
                transfers: Arc::new(Semaphore::new(MAX_ACTIVE_TRANSFERS)),
                shutdown,
            }),
        }
    }

    pub(crate) fn port(&self) -> u16 {
        self.inner.port
    }

    pub(crate) fn router(&self) -> Router {
        http::router(self.clone())
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
        let token = self
            .inner
            .tickets
            .issue(session_id, kind, TICKET_TTL)
            .await?;
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
        self.inner.tickets.clear().await;
    }

    #[cfg(test)]
    pub(crate) async fn ticket_count(&self) -> usize {
        self.inner.tickets.count().await
    }

    async fn peek_download(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.peek(token, false).await
    }

    async fn peek_upload(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.peek(token, true).await
    }

    async fn peek(&self, token: &str, upload: bool) -> Result<TransferTicket, StatusCode> {
        self.inner.tickets.peek(token, upload).await
    }

    async fn begin_download(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.begin(token, false).await
    }

    async fn begin_upload(&self, token: &str) -> Result<TransferTicket, StatusCode> {
        self.begin(token, true).await
    }

    async fn begin(&self, token: &str, upload: bool) -> Result<TransferTicket, StatusCode> {
        self.inner.tickets.begin(token, upload).await
    }

    async fn finish_download(&self, token: &str) {
        self.inner.tickets.finish_download(token).await;
    }

    async fn finish_upload(&self, token: &str, succeeded: bool) {
        self.inner.tickets.finish_upload(token, succeeded).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::McpGroupPermission;
    use crate::services::SettingsService;
    use axum::{
        body::Body,
        extract::{Path, State},
        http::{header, HeaderMap, HeaderName, HeaderValue},
    };
    use http::{
        content_disposition, download_file, head_download_file, upload_file, upload_page,
        X_FRAME_OPTIONS,
    };
    use serde_json::json;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use uuid::Uuid;

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
        runtime.inner.tickets.expire(&token).await;
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
