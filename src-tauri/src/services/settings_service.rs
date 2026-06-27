use crate::models::{AppSettings, Language};

pub struct SettingsService {
    settings: AppSettings,
}

impl Default for SettingsService {
    fn default() -> Self {
        Self {
            settings: AppSettings {
                language: Language::ZhCn,
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
}
