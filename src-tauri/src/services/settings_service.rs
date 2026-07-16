use crate::models::{AppSettings, Language};

pub struct SettingsService {
    settings: AppSettings,
}

impl Default for SettingsService {
    fn default() -> Self {
        Self {
            settings: AppSettings {
                language: Language::ZhCn,
                auto_update: true,
                update_proxy: String::new(),
            },
        }
    }
}

impl SettingsService {
    pub fn get(&self) -> AppSettings {
        self.settings.clone()
    }

    pub fn set_language(&mut self, language: Language) -> AppSettings {
        self.settings.language = language;
        self.settings.clone()
    }

    pub fn update(&mut self, auto_update: bool, update_proxy: String) -> AppSettings {
        self.settings.auto_update = auto_update;
        self.settings.update_proxy = update_proxy;
        self.settings.clone()
    }
}
