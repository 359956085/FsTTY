mod app_update_service;
mod command_history_service;
mod connection_manager;
mod connection_paths;
mod credential_service;
mod device_metrics_service;
mod device_service;
mod lightweight_mode_service;
mod mcp_command_policy_service;
mod mcp_support_service;
mod session_service;
mod session_structure;
mod settings_service;
mod transfer_job_service;

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;

pub use app_update_service::AppUpdateService;
pub use connection_manager::{ConnectionManager, OneTimeLogin};
pub use credential_service::CredentialService;
pub use device_service::DeviceService;
pub use lightweight_mode_service::LightweightModeService;
pub use mcp_command_policy_service::McpCommandPolicyService;
pub use mcp_support_service::{McpAuditService, McpOperationLock, McpOperationLockService};
pub use session_service::SessionService;
pub use settings_service::SettingsService;
pub use transfer_job_service::TransferJobService;

#[derive(Clone)]
pub struct AppState {
    pub app_update_service: AppUpdateService,
    pub app_data_directory: PathBuf,
    pub log_directory: PathBuf,
    pub command_history_service: Arc<StdMutex<CommandHistoryService>>,
    pub session_service: Arc<Mutex<SessionService>>,
    pub credential_service: CredentialService,
    pub connection_manager: ConnectionManager,
    pub device_service: DeviceService,
    pub lightweight_mode_service: LightweightModeService,
    pub settings_service: Arc<StdMutex<SettingsService>>,
    pub transfer_job_service: TransferJobService,
    pub mcp_command_policy_service: Arc<StdMutex<McpCommandPolicyService>>,
    pub mcp_http_runtime: crate::mcp::McpHttpRuntime,
    pub mcp_audit_service: McpAuditService,
    pub mcp_operation_lock_service: McpOperationLockService,
}

impl AppState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let log_directory = app_data_dir.join("logs");
        let mut settings_service = SettingsService::load(&app_data_dir);
        let legacy_permissions = settings_service.get().mcp_group_permissions;
        let policy_service = McpCommandPolicyService::load(&app_data_dir, legacy_permissions);
        if let Ok(permissions) = policy_service.list_permissions() {
            if let Err(error) = settings_service.externalize_mcp_permissions(permissions) {
                log::error!("无法从设置文件移除已迁移的 MCP 权限：{error}");
            }
        }
        Self {
            app_update_service: AppUpdateService::default(),
            app_data_directory: app_data_dir.clone(),
            log_directory: log_directory.clone(),
            command_history_service: Arc::new(StdMutex::new(CommandHistoryService::load(
                &app_data_dir,
            ))),
            session_service: Arc::new(Mutex::new(SessionService::load(&app_data_dir))),
            credential_service: CredentialService::new(),
            connection_manager: ConnectionManager::new(&app_data_dir),
            device_service: DeviceService,
            lightweight_mode_service: LightweightModeService::load(&app_data_dir),
            settings_service: Arc::new(StdMutex::new(settings_service)),
            transfer_job_service: TransferJobService::default(),
            mcp_command_policy_service: Arc::new(StdMutex::new(policy_service)),
            mcp_http_runtime: crate::mcp::McpHttpRuntime::default(),
            mcp_audit_service: McpAuditService::new(&log_directory),
            mcp_operation_lock_service: McpOperationLockService::new(&app_data_dir),
        }
    }
}
pub use command_history_service::CommandHistoryService;
