mod connection_manager;
mod credential_service;
mod device_service;
mod session_service;
mod settings_service;

use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

pub use connection_manager::ConnectionManager;
pub use credential_service::CredentialService;
pub use device_service::DeviceService;
pub use session_service::SessionService;
pub use settings_service::SettingsService;

pub struct AppState {
    pub session_service: Mutex<SessionService>,
    pub credential_service: CredentialService,
    pub connection_manager: ConnectionManager,
    pub device_service: DeviceService,
    pub settings_service: StdMutex<SettingsService>,
}

impl AppState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            session_service: Mutex::new(SessionService::load(&app_data_dir)),
            credential_service: CredentialService,
            connection_manager: ConnectionManager::new(&app_data_dir),
            device_service: DeviceService,
            settings_service: StdMutex::new(SettingsService::default()),
        }
    }
}
