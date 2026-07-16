import { useState } from "react";
import { Globe2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { AppSettings, Language } from "../../shared/api/types";

interface SettingsPageProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

export function SettingsPage({ settings, onChange }: SettingsPageProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [proxy, setProxy] = useState(settings.updateProxy);

  async function handleLanguageChange(language: Language) {
    setError(null);
    try {
      const nextSettings = await api.setLanguage(language);
      onChange(nextSettings);
    } catch (nextError) {
      setError(resolveApiError(nextError, t("errors.unknown")));
    }
  }

  async function handleUpdateSettings(autoUpdate: boolean, updateProxy = proxy) {
    setError(null);
    try {
      const nextSettings = await api.updateAppSettings(autoUpdate, updateProxy.trim());
      setProxy(nextSettings.updateProxy);
      onChange(nextSettings);
    } catch (nextError) {
      setError(resolveApiError(nextError, t("errors.unknown")));
    }
  }

  return (
    <section aria-labelledby="settings-title" className="settings-page">
      <header className="page-header">
        <h1 id="settings-title">{t("settings.title")}</h1>
        <p>{t("settings.language")}</p>
      </header>

      <section aria-labelledby="language-setting-title" className="settings-panel">
        <div className="settings-row">
          <h2 className="settings-row-title" id="language-setting-title">
            <Globe2 aria-hidden="true" size={18} />
            <span>{t("settings.language")}</span>
          </h2>
          <div
            aria-label={t("settings.language")}
            className="segmented-control"
            role="group"
          >
            <button
              aria-pressed={settings.language === "zh-CN"}
              className={settings.language === "zh-CN" ? "segment segment-active" : "segment"}
              onClick={() => void handleLanguageChange("zh-CN")}
              type="button"
            >
              {t("settings.chinese")}
            </button>
            <button
              aria-pressed={settings.language === "en-US"}
              className={settings.language === "en-US" ? "segment segment-active" : "segment"}
              onClick={() => void handleLanguageChange("en-US")}
              type="button"
            >
              {t("settings.english")}
            </button>
          </div>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
      </section>
      <section className="settings-panel">
        <div className="settings-row">
          <h2 className="settings-row-title">
            <RefreshCw aria-hidden="true" size={18} />
            <span>{t("settings.autoUpdate")}</span>
          </h2>
          <input
            aria-label={t("settings.autoUpdate")}
            checked={settings.autoUpdate}
            onChange={(event) => void handleUpdateSettings(event.target.checked)}
            type="checkbox"
          />
        </div>
        <div className="settings-row">
          <label className="settings-row-title" htmlFor="update-proxy">
            <span>{t("settings.updateProxy")}</span>
          </label>
          <input
            className="text-input settings-proxy-input"
            id="update-proxy"
            onChange={(event) => setProxy(event.target.value)}
            onBlur={() => void handleUpdateSettings(settings.autoUpdate)}
            placeholder="http://127.0.0.1:7890"
            value={proxy}
          />
        </div>
      </section>
    </section>
  );
}
