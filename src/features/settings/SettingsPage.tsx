import { useState } from "react";
import { Globe2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import type { AppSettings, Language } from "../../shared/api/types";

interface SettingsPageProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

export function SettingsPage({ settings, onChange }: SettingsPageProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  async function handleLanguageChange(language: Language) {
    setError(null);
    try {
      const nextSettings = await api.setLanguage(language);
      onChange(nextSettings);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("errors.unknown"));
    }
  }

  return (
    <section className="settings-page">
      <header className="page-header">
        <div>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.language")}</p>
        </div>
      </header>

      <div className="settings-panel">
        <div className="settings-row">
          <div className="settings-row-title">
            <Globe2 size={18} />
            <span>{t("settings.language")}</span>
          </div>
          <div className="segmented-control">
            <button
              className={settings.language === "zh-CN" ? "segment segment-active" : "segment"}
              onClick={() => void handleLanguageChange("zh-CN")}
              type="button"
            >
              {t("settings.chinese")}
            </button>
            <button
              className={settings.language === "en-US" ? "segment segment-active" : "segment"}
              onClick={() => void handleLanguageChange("en-US")}
              type="button"
            >
              {t("settings.english")}
            </button>
          </div>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
      </div>
    </section>
  );
}

