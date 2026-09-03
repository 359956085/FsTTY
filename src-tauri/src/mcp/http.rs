use super::McpService;
use crate::mcp_transfer::McpTransferRuntime;
use crate::models::AppError;
use crate::services::AppState;
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

const MCP_TOKEN_ACCOUNT: &str = "__mcp_http_token";

#[derive(Clone, Default)]
pub struct McpHttpRuntime {
    pub(super) state: Arc<Mutex<McpHttpRuntimeState>>,
    transition: Arc<Mutex<()>>,
}

#[derive(Default)]
pub(super) struct McpHttpRuntimeState {
    pub(super) running: Option<RunningMcpHttp>,
}

pub(super) struct RunningMcpHttp {
    pub(super) port: u16,
    pub(super) cancellation: CancellationToken,
    pub(super) bearer_token: Arc<RwLock<Zeroizing<String>>>,
    pub(super) transfer_runtime: McpTransferRuntime,
}

impl McpHttpRuntime {
    pub async fn stop(&self) {
        let _transition = self.transition.lock().await;
        let running = self.state.lock().await.running.take();
        if let Some(running) = running {
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
        let _transition = self.transition.lock().await;
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
        let _transition = self.transition.lock().await;
        let existing = self.state.lock().await.running.as_ref().map(|running| {
            (
                running.port,
                running.bearer_token.clone(),
                running.transfer_runtime.clone(),
            )
        });
        if let Some((running_port, token, transfer_runtime)) = existing {
            if running_port == port {
                let changed = token.read().await.as_str() != bearer_token;
                if changed {
                    *token.write().await = Zeroizing::new(bearer_token);
                    transfer_runtime.clear().await;
                }
                return Ok(());
            }
        }

        // 先绑定新端口。绑定失败时保留旧监听，避免设置保存失败连带中断现有客户端。
        let listener = bind_http_listener(port)
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
        let previous = self.state.lock().await.running.replace(RunningMcpHttp {
            port,
            cancellation: cancellation.clone(),
            bearer_token: auth_token,
            transfer_runtime,
        });
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

pub(super) fn http_bind_address(port: u16) -> std::net::SocketAddr {
    std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port))
}

async fn bind_http_listener(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Networking::WinSock::{
            setsockopt, WSAGetLastError, SOCKET_ERROR, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
        };

        let socket = tokio::net::TcpSocket::new_v4()?;
        let exclusive = 1i32;
        // Windows 默认允许通配监听与同用户的回环监听共存；本地客户端可能连到别的服务。
        // 套接字和选项值在调用期间有效，独占设置须在 bind 前完成，失败时拒绝继续启动。
        let result = unsafe {
            setsockopt(
                socket.as_raw_socket() as _,
                SOL_SOCKET,
                SO_EXCLUSIVEADDRUSE,
                std::ptr::from_ref(&exclusive).cast(),
                std::mem::size_of_val(&exclusive) as i32,
            )
        };
        if result == SOCKET_ERROR {
            return Err(std::io::Error::from_raw_os_error(unsafe {
                WSAGetLastError()
            }));
        }
        socket.bind(http_bind_address(port))?;
        // 与原 TcpListener::bind 使用的 Mio 默认积压队列一致。
        socket.listen(128)
    }
    #[cfg(not(windows))]
    tokio::net::TcpListener::bind(http_bind_address(port)).await
}

pub(super) fn http_server_config(
    cancellation_token: CancellationToken,
) -> StreamableHttpServerConfig {
    // rmcp 默认只接受回环 Host。远程模式的地址无法预先固定，故由令牌和 Origin 中间件承担访问保护。
    StreamableHttpServerConfig::default()
        .disable_allowed_hosts()
        .with_cancellation_token(cancellation_token)
}

pub(super) fn validate_http_headers(
    headers: &HeaderMap,
    expected_token: &str,
) -> Result<(), StatusCode> {
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

pub async fn get_http_token(state: &AppState) -> Result<Option<Zeroizing<String>>, AppError> {
    state.credential_service.get(MCP_TOKEN_ACCOUNT).await
}

pub async fn get_or_create_http_token(state: &AppState) -> Result<Zeroizing<String>, AppError> {
    if let Some(token) = get_http_token(state).await? {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 回环已有监听时拒绝全地址监听() {
        let existing = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        assert!(bind_http_listener(existing.local_addr().unwrap().port())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn 全地址监听独占回环且关闭后可重新绑定() {
        let listener = bind_http_listener(0).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_unspecified());
        assert!(
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, address.port()))
                .await
                .is_err()
        );
        drop(listener);
        let reopened = bind_http_listener(address.port()).await.unwrap();
        assert_eq!(reopened.local_addr().unwrap(), address);
    }
}
