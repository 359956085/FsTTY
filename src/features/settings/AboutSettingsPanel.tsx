import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import type { AppSettings } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";
import type { AppUpdaterController } from "./useAppUpdater";

const PROJECT_URL = "https://github.com/359956085/FsTTY";
const CONTACT_EMAIL = "359956085@163.com";

interface AboutSettingsPanelProps {
  error: string | null;
  onAutoUpdateChange: (enabled: boolean) => void;
  onCheckUpdates: () => void;
  onProxyChange: (value: string) => void;
  onProxyCommit: () => void;
  proxy: string;
  savingUpdateSettings: boolean;
  settings: AppSettings;
  status: string | null;
  updater: AppUpdaterController;
}

export function AboutSettingsPanel({
  error,
  onAutoUpdateChange,
  onCheckUpdates,
  onProxyChange,
  onProxyCommit,
  proxy,
  savingUpdateSettings,
  settings,
  status,
  updater,
}: AboutSettingsPanelProps) {
  const { t } = useTranslation();
  const [emailCopied, setEmailCopied] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function openProject() {
    setLinkError(null);
    try {
      await api.openProjectLink();
    } catch {
      setLinkError(t("settings.openAboutLinkFailed"));
    }
  }

  async function copyEmail() {
    setLinkError(null);
    try {
      await writeText(CONTACT_EMAIL);
      setEmailCopied(true);
    } catch {
      setEmailCopied(false);
      setLinkError(t("settings.copyEmailFailed"));
    }
  }

  return (
    <>
      <section aria-labelledby="about-product-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="about-product-title">FsTTY</h3>
        </header>
        <div className="settings-row">
          <span className="settings-row-label">{t("settings.projectAddress")}</span>
          <button
            className="settings-about-link"
            onClick={() => void openProject()}
            type="button"
          >
            <span>{PROJECT_URL}</span>
            <ExternalLink aria-hidden="true" size={14} />
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t("settings.contactEmail")}</span>
          <button
            className="settings-about-link"
            onClick={() => void copyEmail()}
            title={emailCopied ? t("settings.emailCopied") : t("settings.copyEmail")}
            type="button"
          >
            <span>{CONTACT_EMAIL}</span>
            {emailCopied ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
          </button>
        </div>
        <div className="settings-row settings-about-last-row">
          <span className="settings-row-label">{t("settings.currentVersion")}</span>
          <span className="settings-current-version">
            {updater.currentVersion ? `v${updater.currentVersion}` : "—"}
          </span>
        </div>
        {linkError ? (
          <div className="form-error settings-error" role="alert">
            {linkError}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="update-settings-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="update-settings-title">{t("settings.appUpdate")}</h3>
        </header>
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
              icon={<RefreshCw aria-hidden="true" size={16} />}
              onClick={onCheckUpdates}
            >
              {updater.phase === "checking"
                ? t("settings.checkingUpdate")
                : t("settings.checkUpdate")}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="auto-update">
              {t("settings.autoUpdate")}
            </label>
            <small>{t("settings.autoUpdateHint")}</small>
          </div>
          <input
            aria-label={t("settings.autoUpdate")}
            checked={settings.autoUpdate}
            className="settings-auto-update-toggle"
            disabled={savingUpdateSettings}
            id="auto-update"
            onChange={(event) => onAutoUpdateChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
        <div className="settings-row settings-proxy-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="update-proxy">
              {t("settings.updateProxy")}
            </label>
            <small>{t("settings.updateProxyHint")}</small>
          </div>
          <TextInput
            className="settings-proxy-input"
            disabled={savingUpdateSettings || updater.phase === "downloading"}
            id="update-proxy"
            onBlur={onProxyCommit}
            onChange={(event) => onProxyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            placeholder="http://127.0.0.1:7890"
            value={proxy}
          />
        </div>
        {error ? <div className="form-error settings-error">{error}</div> : null}
      </section>
    </>
  );
}
