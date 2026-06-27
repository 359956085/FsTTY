mod device_service;
mod file_service;
mod session_service;
mod settings_service;

use std::sync::Mutex;

pub use device_service::DeviceService;
pub use file_service::FileService;
pub use session_service::SessionService;
pub use settings_service::SettingsService;

pub struct AppState {
    pub session_service: Mutex<SessionService>,
    pub file_service: FileService,
    pub device_service: DeviceService,
    pub settings_service: Mutex<SettingsService>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session_service: Mutex::new(SessionService::default()),
            file_service: FileService,
            device_service: DeviceService,
            settings_service: Mutex::new(SettingsService::default()),
        }
    }
}
