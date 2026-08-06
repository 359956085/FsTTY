import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppSettings, Language } from "../../shared/api/types";
import { Select } from "../../shared/ui/Select";
import { SettingsIconAction } from "./SettingsIconAction";
import { CommandHistorySettingsSection } from "./CommandHistorySettingsSection";
import { ShortcutSettingsSection } from "./ShortcutSettingsSection";

interface GeneralSettingsPanelProps {
  activeTooltipKey: string | null;
  logDirectoryError: string | null;
  logSettingsError: string | null;
  onClipboardChange: (enabled: boolean) => void;
  onHideTooltip: () => void;
  onLanguageChange: (language: Language) => void;
  onOpenLogDirectory: () => void;
  onRecordMcpToolInputsChange: (enabled: boolean) => void;
  onShowTooltip: (key: string, text: string, element: HTMLElement) => void;
  onSettingsChange: (settings: AppSettings) => void;
  openingLogDirectory: boolean;
  savingLanguage: boolean;
  savingLogSettings: boolean;
  savingUpdateSettings: boolean;
  settings: AppSettings;
}

export function GeneralSettingsPanel({
  activeTooltipKey,
  logDirectoryError,
  logSettingsError,
  onClipboardChange,
  onHideTooltip,
  onLanguageChange,
  onOpenLogDirectory,
  onRecordMcpToolInputsChange,
  onShowTooltip,
  onSettingsChange,
  openingLogDirectory,
  savingLanguage,
  savingLogSettings,
  savingUpdateSettings,
  settings,
}: GeneralSettingsPanelProps) {
  const { t } = useTranslation();

  return (
    <>
      <section aria-labelledby="general-settings-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="general-settings-title">{t("settings.generalSettings")}</h3>
        </header>
        <div className="settings-row settings-language-row">
          <span className="settings-row-label">{t("settings.language")}</span>
          <Select<Language>
            ariaLabel={t("settings.language")}
            className="settings-language-select"
            disabled={savingLanguage}
            onChange={onLanguageChange}
            options={[
              { value: "zh-CN", label: t("settings.chinese") },
              { value: "en-US", label: t("settings.english") },
            ]}
            value={settings.language}
          />
        </div>
        <div className="settings-row settings-clipboard-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="remote-clipboard-write">
              {t("settings.remoteClipboardWrite")}
            </label>
            <small>{t("settings.remoteClipboardWriteHint")}</small>
          </div>
          <input
            aria-label={t("settings.remoteClipboardWrite")}
            checked={settings.allowRemoteClipboardWrite}
            className="settings-auto-update-toggle"
            disabled={savingUpdateSettings}
            id="remote-clipboard-write"
            onChange={(event) => onClipboardChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
      </section>

      <ShortcutSettingsSection onChange={onSettingsChange} settings={settings.shortcuts} />

      <CommandHistorySettingsSection />

      <section aria-labelledby="log-settings-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="log-settings-title">{t("settings.logs")}</h3>
        </header>
        <div className="settings-row">
          <div className="settings-row-copy">
            <span className="settings-row-label">{t("settings.logDirectory")}</span>
            <small>{t("settings.logsHint")}</small>
          </div>
          <SettingsIconAction
            activeTooltipKey={activeTooltipKey}
            disabled={openingLogDirectory}
            label={t("settings.openLogDirectory")}
            onActivate={onOpenLogDirectory}
            onHideTooltip={onHideTooltip}
            onShowTooltip={onShowTooltip}
            tooltipKey="open-log-directory"
          >
            <FolderOpen aria-hidden="true" size={16} />
          </SettingsIconAction>
        </div>
        {logDirectoryError ? (
          <div className="form-error settings-error" role="alert">
            {logDirectoryError}
          </div>
        ) : null}
        <div className="settings-row settings-log-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="record-mcp-tool-inputs">
              {t("settings.recordMcpToolInputs")}
            </label>
            <small>{t("settings.recordMcpToolInputsHint")}</small>
          </div>
          <input
            aria-label={t("settings.recordMcpToolInputs")}
            checked={settings.recordMcpToolInputs}
            className="settings-auto-update-toggle"
            disabled={savingLogSettings}
            id="record-mcp-tool-inputs"
            onChange={(event) => onRecordMcpToolInputsChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
        {logSettingsError ? (
          <div className="form-error settings-error" role="alert">
            {logSettingsError}
          </div>
        ) : null}
      </section>
    </>
  );
}
