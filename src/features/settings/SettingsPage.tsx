import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { AppSettings, Language } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { TextInput } from "../../shared/ui/TextInput";
import type { AppUpdaterController } from "./useAppUpdater";

interface SettingsPageProps {
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  updater: AppUpdaterController;
}

export function SettingsPage({ settings, onChange, updater }: SettingsPageProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [proxy, setProxy] = useState(settings.updateProxy);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [savingUpdateSettings, setSavingUpdateSettings] = useState(false);
  const updateSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => setProxy(settings.updateProxy), [settings.updateProxy]);

  async function handleLanguageChange(language: Language) {
    if (savingLanguage) {
      return;
    }
    setSavingLanguage(true);
    setError(null);
    try {
      const nextSettings = await api.setLanguage(language);
      onChange(nextSettings);
    } catch (nextError) {
      setError(resolveApiError(nextError, t("errors.unknown")));
    } finally {
      setSavingLanguage(false);
    }
  }

  async function saveUpdateSettings(autoUpdate: boolean, updateProxy = proxy) {
    setSavingUpdateSettings(true);
    const save = updateSettingsSaveRef.current.then(async () => {
      setSavingUpdateSettings(true);
      setError(null);
      try {
        const nextSettings = await api.updateAppSettings(autoUpdate, updateProxy.trim());
        setProxy(nextSettings.updateProxy);
        onChange(nextSettings);
        return nextSettings;
      } catch (nextError) {
        setError(resolveApiError(nextError, t("errors.unknown")));
        return null;
      }
    });
    // 失焦、开关和检查按钮可能连续触发保存，串行写入才能保证最后一次操作生效。
    const queueTail = save.then(
      () => undefined,
      () => undefined,
    );
    updateSettingsSaveRef.current = queueTail;
    try {
      return await save;
    } finally {
      if (updateSettingsSaveRef.current === queueTail) {
        setSavingUpdateSettings(false);
      }
    }
  }

  async function handleCheckForUpdates() {
    const saved = await saveUpdateSettings(settings.autoUpdate);
    if (saved) {
      await updater.checkForUpdates("manual", saved.updateProxy);
    }
  }

  const status = (() => {
    if (updater.phase === "checking") {
      return t("settings.checkingUpdate");
    }
    if (updater.phase === "upToDate") {
      return t("settings.upToDate");
    }
    if (updater.phase === "available" && updater.availableUpdate) {
      return t("settings.updateAvailable", { version: updater.availableUpdate.version });
    }
    if (updater.phase === "downloading") {
      return t("settings.downloadingUpdate");
    }
    if (updater.phase === "installing") {
      return t("settings.installingUpdate");
    }
    if (updater.phase === "completed") {
      return t("settings.updateInstalled");
    }
    return null;
  })();
  const visibleError =
    error ||
    updater.versionError ||
    (updater.phase === "error" && !updater.dialogOpen
      ? updater.error || t("settings.updateUnknownError")
      : null);

  return (
    <section aria-labelledby="settings-title" className="settings-page">
      <h1 className="sr-only" id="settings-title">
        {t("settings.title")}
      </h1>
      <div className="settings-content">
        <section aria-labelledby="general-settings-title" className="settings-panel">
          <header className="settings-panel-header">
            <h2 id="general-settings-title">{t("settings.general")}</h2>
          </header>
          <div className="settings-row settings-language-row">
            <span className="settings-row-label">{t("settings.language")}</span>
            <Select<Language>
              ariaLabel={t("settings.language")}
              className="settings-language-select"
              disabled={savingLanguage}
              onChange={(language) => void handleLanguageChange(language)}
              options={[
                { value: "zh-CN", label: t("settings.chinese") },
                { value: "en-US", label: t("settings.english") },
              ]}
              value={settings.language}
            />
          </div>
        </section>

        <section aria-labelledby="version-settings-title" className="settings-panel">
          <header className="settings-panel-header">
            <h2 id="version-settings-title">{t("settings.version")}</h2>
          </header>
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.currentVersion")}</span>
            <span className="settings-current-version">
              {updater.currentVersion ? `v${updater.currentVersion}` : "—"}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.checkUpdate")}</span>
            <div className="settings-update-control">
              {status ? (
                <span aria-live="polite" className="settings-update-status">
                  {status}
                </span>
              ) : null}
              <Button
                disabled={updater.busy || savingUpdateSettings}
                onClick={() => void handleCheckForUpdates()}
                variant="ghost"
              >
                {updater.phase === "checking"
                  ? t("settings.checkingUpdate")
                  : t("settings.checkUpdate")}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <label className="settings-row-label" htmlFor="auto-update">
              {t("settings.autoUpdate")}
            </label>
            <input
              aria-label={t("settings.autoUpdate")}
              checked={settings.autoUpdate}
              className="settings-auto-update-toggle"
              disabled={savingUpdateSettings}
              id="auto-update"
              onChange={(event) => void saveUpdateSettings(event.target.checked)}
              role="switch"
              type="checkbox"
            />
          </div>
          <div className="settings-row settings-proxy-row">
            <label className="settings-row-label" htmlFor="update-proxy">
              {t("settings.updateProxy")}
            </label>
            <TextInput
              className="settings-proxy-input"
              disabled={savingUpdateSettings || updater.phase === "downloading"}
              id="update-proxy"
              onBlur={() => void saveUpdateSettings(settings.autoUpdate)}
              onChange={(event) => setProxy(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder="http://127.0.0.1:7890"
              value={proxy}
            />
          </div>
          {visibleError ? <div className="form-error settings-error">{visibleError}</div> : null}
        </section>
      </div>
    </section>
  );
}
