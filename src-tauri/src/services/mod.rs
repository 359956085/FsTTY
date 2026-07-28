mod connection_manager;
mod credential_service;
mod device_service;
mod mcp_support_service;
mod session_service;
mod settings_service;

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;

pub use connection_manager::{ConnectionManager, OneTimeLogin};
pub use credential_service::CredentialService;
pub use device_service::DeviceService;
pub use mcp_support_service::{McpAuditService, McpOperationLock, McpOperationLockService};
pub use session_service::SessionService;
pub use settings_service::SettingsService;

#[derive(Clone)]
pub struct AppState {
    pub session_service: Arc<Mutex<SessionService>>,
    pub credential_service: CredentialService,
    pub connection_manager: ConnectionManager,
    pub device_service: DeviceService,
    pub settings_service: Arc<StdMutex<SettingsService>>,
    pub mcp_http_runtime: crate::mcp::McpHttpRuntime,
    pub mcp_audit_service: McpAuditService,
    pub mcp_operation_lock_service: McpOperationLockService,
}

impl AppState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            session_service: Arc::new(Mutex::new(SessionService::load(&app_data_dir))),
            credential_service: CredentialService::new(),
            connection_manager: ConnectionManager::new(&app_data_dir),
            device_service: DeviceService,
            settings_service: Arc::new(StdMutex::new(SettingsService::load(&app_data_dir))),
            mcp_http_runtime: crate::mcp::McpHttpRuntime::default(),
            mcp_audit_service: McpAuditService::new(&app_data_dir),
            mcp_operation_lock_service: McpOperationLockService::new(&app_data_dir),
        }
    }
}
