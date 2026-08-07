import { Check, Copy, ExternalLink, History, RefreshCw } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import type { AppSettings, UpdateSourcePreference } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { TextInput } from "../../shared/ui/TextInput";
import type { AppUpdaterController } from "./useAppUpdater";

const PROJECT_URL = "https://github.com/359956085/FsTTY";
const CONTACT_EMAIL = "359956085@163.com";

const UpdateHistoryDialog = lazy(() =>
  import("./UpdateHistoryDialog").then((module) => ({
    default: module.UpdateHistoryDialog,
  })),
);

interface AboutSettingsPanelProps {
  error: string | null;
  onAutoUpdateChange: (enabled: boolean) => void;
  onCheckUpdates: () => void;
  onProxyChange: (value: string) => void;
  onProxyCommit: () => void;
  onUpdateSourceChange: (source: UpdateSourcePreference) => void;
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
  onUpdateSourceChange,
  proxy,
  savingUpdateSettings,
  settings,
  status,
  updater,
}: AboutSettingsPanelProps) {
  const { t } = useTranslation();
  const [emailCopied, setEmailCopied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
            <span className="settings-row-label">{t("settings.updateSource")}</span>
            <small>{t("settings.updateSourceHint")}</small>
          </div>
          <Select<UpdateSourcePreference>
            ariaLabel={t("settings.updateSource")}
            className="settings-update-source-select"
            disabled={savingUpdateSettings || updater.busy}
            onChange={onUpdateSourceChange}
            options={[
              { value: "auto", label: t("settings.updateSourceAuto") },
              { value: "github", label: "GitHub" },
              { value: "cnb", label: "CNB" },
            ]}
            value={settings.updateSource}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-copy">
            <span className="settings-row-label">{t("settings.updateHistory")}</span>
            <small>{t("settings.updateHistoryHint")}</small>
          </div>
          <Button
            icon={<History aria-hidden="true" size={16} />}
            onClick={() => setHistoryOpen(true)}
            variant="ghost"
          >
            {t("settings.viewUpdateHistory")}
          </Button>
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
      {historyOpen ? (
        <Suspense
          fallback={
            <div className="dialog-backdrop update-dialog-backdrop">
              <div className="loading-banner">{t("common.loading")}</div>
            </div>
          }
        >
          <UpdateHistoryDialog onClose={() => setHistoryOpen(false)} open />
        </Suspense>
      ) : null}
    </>
  );
}
